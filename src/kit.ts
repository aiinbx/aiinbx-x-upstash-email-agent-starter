import AIInbx, { type ListEventsQuery, type WebhookEvent } from "aiinbx"
import { verifyWebhookRequest, WebhookSignatureError } from "aiinbx/webhooks"
import { Bucket } from "@upstash/blob"
import { Redis } from "@upstash/redis"
import { Index } from "@upstash/vector"
import {
  Client as WorkflowClient,
  serve,
  type TriggerOptions,
  type WorkflowReceiver,
} from "@upstash/workflow"
import {
  addressKey,
  ALL_INBOXES,
  assertName,
  blobPaths,
  DEFAULT_TENANT,
  keys,
  vectorNamespace,
  type ChunkMetadata,
  type Context,
  type Limits,
} from "./context"
import { handleEmail, type HandleOptions, type HandleOutcome } from "./handle"
import { copyAttachment, ingestEmail, planAttachments, saveEmail, type IngestHints } from "./ingest"
import { createScope, type ScopeOptions } from "./scope"
import { createEmailTools } from "./tools"
import { statusEntry } from "./status"
import type { DeliveryStatus, StoredEmail } from "./types"

export interface EmailKitOptions extends HandleOptions {
  /** Defaults read `AI_INBX_API_KEY`, `UPSTASH_REDIS_REST_*`, `UPSTASH_VECTOR_REST_*`, `UPSTASH_BLOB_TOKEN`. */
  aiinbx?: AIInbx
  redis?: Redis
  vector?: Index<ChunkMetadata>
  bucket?: Bucket
  /** Signing secret of the AI Inbx webhook endpoint. Default: `AI_INBX_WEBHOOK_SECRET`. */
  webhookSecret?: string
  /**
   * Prefix of every Redis key, Blob path and Vector namespace, one per
   * environment. Letters, digits, `-`, `_` and `.`. Default `mail`.
   */
  prefix?: string
  /**
   * The tenant an AI Inbx space's mail belongs to. Default: the space's id,
   * and `default` for mail outside spaces. Each tenant's mail, files and
   * vectors are stored apart.
   */
  tenantOf?: (spaceId: string | null) => string
  /** Display name on mail the handler's tools send. */
  name?: string
  /** Have the handler's tools save drafts for a person to approve instead of sending. */
  drafts?: boolean
  /**
   * Run each email through Upstash Workflow: the webhook only enqueues, and
   * every step retries on its own. `url` is where `kit.workflow` is mounted.
   * Signatures are checked with `QSTASH_CURRENT_SIGNING_KEY` and
   * `QSTASH_NEXT_SIGNING_KEY`, or the `receiver` given. Without `workflow`,
   * the webhook stores and handles each email before it answers.
   */
  workflow?: {
    url: string
    client?: WorkflowClient
    receiver?: WorkflowReceiver
    /**
     * Which emails wait for each other. Default: one at a time per thread,
     * so two emails of one conversation never reach the handler at once.
     * For a cap per tenant: `({ tenant }) => ({ key: tenant, parallelism: 5 })`.
     */
    flowControl?: (email: { tenant: string; threadId: string }) => TriggerOptions["flowControl"]
    /**
     * Wait this long after an email arrives before the agent runs. A
     * follow-up in the same thread within the window is answered together
     * with it: the earlier email's run steps aside, and the latest one's run
     * hands the agent the whole thread. The wait holds no flow-control slot.
     */
    followUpSeconds?: number
  }
  limits?: Partial<Limits>
}

export interface IngestResult {
  email: StoredEmail
  /** What `onEmail` did, per inbox the email reached. */
  outcomes: Record<string, HandleOutcome>
}

const DEFAULT_LIMITS: Limits = {
  maxChunksPerDocument: 200,
  maxCharsPerMessage: 6_000,
}

const STATUS_EVENTS: Record<string, DeliveryStatus> = {
  "email.delivered": "delivered",
  "email.bounced": "bounced",
  "email.failed": "failed",
  "email.complained": "complained",
}

/** The events the kit acts on: new mail, and what became of mail sent. */
const EVENT_TYPES = ["email.received", "email.sent", ...Object.keys(STATUS_EVENTS)] as NonNullable<
  ListEventsQuery["type"]
>

export type EmailKit = ReturnType<typeof createEmailKit>

export function createEmailKit(options: EmailKitOptions = {}) {
  const prefix = options.prefix ?? "mail"
  assertName("prefix", prefix)
  const ctx: Context = {
    aiinbx: options.aiinbx ?? new AIInbx(),
    redis: options.redis ?? Redis.fromEnv(),
    index: options.vector ?? (Index.fromEnv() as Index<ChunkMetadata>),
    bucket: options.bucket ?? Bucket.fromEnv(),
    prefix,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    tenantOf: (spaceId) => {
      const tenant = options.tenantOf ? options.tenantOf(spaceId) : (spaceId ?? DEFAULT_TENANT)
      assertName("tenant", tenant)
      return tenant
    },
  }

  /** A tenant's mail as some of its inboxes see it. Tools and your own app read through it. */
  function scope(scopeOptions: ScopeOptions) {
    return createScope(ctx, (id) => ingest(id, { handle: false }), scopeOptions)
  }

  /** The scope and tools a handler gets: acting as the inbox the email reached. */
  function forInbox(email: StoredEmail) {
    return (inbox: string) => {
      const s = scope({ tenant: email.tenant, inboxes: inbox, name: options.name })
      return {
        scope: s,
        tools: createEmailTools(s, { email, drafts: options.drafts }),
      }
    }
  }

  async function handle(email: StoredEmail, owner: string) {
    const outcomes: Record<string, HandleOutcome> = {}
    for (const inbox of email.inboxes) {
      outcomes[inbox] = await handleEmail(ctx, email, inbox, {
        ...options,
        owner,
        forInbox: forInbox(email),
      })
    }
    return outcomes
  }

  /** Store an email, and unless `handle` is false hand it to `onEmail`, all in this call. */
  async function ingest(
    emailId: string,
    { hints, handle: run = true }: { hints?: IngestHints; handle?: boolean } = {},
  ): Promise<IngestResult> {
    const email = await ingestEmail(ctx, emailId, hints)
    return { email, outcomes: run ? await handle(email, crypto.randomUUID()) : {} }
  }

  const workflowClient = options.workflow
    ? (options.workflow.client ?? new WorkflowClient({ token: env("QSTASH_TOKEN") }))
    : null

  /** False when another delivery of the same email is still being handled. */
  async function enqueue(
    payload: WorkflowPayload,
    at: { spaceId: string | null; threadId: string },
  ): Promise<boolean> {
    if (!options.workflow || !workflowClient) {
      const { outcomes } = await ingest(payload.email_id, payload)
      return !Object.values(outcomes).includes("in_progress")
    }
    const tenant = ctx.tenantOf(at.spaceId)
    await workflowClient.trigger({
      url: options.workflow.url,
      body: payload,
      flowControl: options.workflow.flowControl
        ? options.workflow.flowControl({ tenant, threadId: at.threadId })
        : { key: `${prefix}-${tenant}-${at.threadId}`, parallelism: 1 },
      label: "email",
    })
    return true
  }

  /** `POST` handler for the AI Inbx webhook endpoint. Web-standard: mount it anywhere. */
  async function webhook(request: Request): Promise<Response> {
    const secret = options.webhookSecret ?? env("AI_INBX_WEBHOOK_SECRET")
    if (!secret) throw new Error("Set AI_INBX_WEBHOOK_SECRET or pass webhookSecret")
    let event
    try {
      event = await verifyWebhookRequest(request, secret)
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        return Response.json({ error: error.message }, { status: 401 })
      }
      throw error
    }
    // Still being handled by an earlier delivery: ask AI Inbx to try again
    // later, so the email is not given up on if that run dies.
    if (!(await dispatch(event))) {
      return new Response(null, { status: 503, headers: { "Retry-After": "60" } })
    }
    return new Response(null, { status: 204 })
  }

  /**
   * Act on one event, from the webhook or from `catchUp`. Safe to repeat:
   * storing is idempotent, handling is claimed once, statuses only move
   * forward. False when the email is still being handled elsewhere.
   */
  async function dispatch(event: WebhookEvent): Promise<boolean> {
    const at = { spaceId: event.space_id }
    if (event.type === "email.received") {
      const { email_id, thread_id, domain_id, to } = event.data
      // Envelope recipients are exact for mail received on a domain; mail
      // synced from a mailbox is filed under that mailbox.
      const hints = domain_id ? { recipients: to } : {}
      return enqueue({ email_id, hints, handle: true }, { ...at, threadId: thread_id })
    }
    if (event.type === "email.sent") {
      const { email_id, thread_id } = event.data
      return enqueue({ email_id, hints: {}, handle: true }, { ...at, threadId: thread_id })
    }
    // A soft bounce, such as a full mailbox, leaves the status as it was.
    if (event.type === "email.bounced" && !event.data.permanent) return true
    const status = STATUS_EVENTS[event.type]
    if (status && "email_id" in event.data) {
      const k = keys(prefix, ctx.tenantOf(event.space_id))
      await ctx.redis.zadd(k.status(event.data.email_id), statusEntry(status))
    }
    return true
  }
  /**
   * `POST` handler for Upstash Workflow, mounted at `workflow.url`. Built on
   * first use: `serve` starts a local QStash under `QSTASH_DEV`, which a kit
   * that never runs a workflow has no use for.
   */
  let workflowHandler: ((request: Request) => Promise<Response>) | undefined
  const workflow = (request: Request) => (workflowHandler ??= createWorkflowHandler())(request)
  function createWorkflowHandler() {
    const dev = ["true", "1"].includes(env("QSTASH_DEV") ?? "")
    const signed = env("QSTASH_CURRENT_SIGNING_KEY") && env("QSTASH_NEXT_SIGNING_KEY")
    if (!dev && !signed && !options.workflow?.receiver) {
      // Without keys `serve` accepts unsigned requests: anyone could feed it emails.
      throw new Error("Set QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY")
    }
    return serve<WorkflowPayload>(
      async (context) => {
        const { email_id, hints, handle: shouldHandle } = context.requestPayload
        const jobs = await context.run("plan", () => planAttachments(ctx, email_id))
        for (const job of jobs) {
          await context.run(`attachment-${job.id}`, () => copyAttachment(ctx, job))
        }
        // Step results travel through QStash: keep them small.
        const { tenant, inboxes } = await context.run("save", async () => {
          const email = await saveEmail(ctx, email_id, hints)
          return { tenant: email.tenant, inboxes: email.inboxes }
        })
        if (!shouldHandle) return
        const followUp = options.workflow?.followUpSeconds
        if (followUp) await context.sleep("wait-for-follow-ups", followUp)
        for (const inbox of inboxes) {
          await context.run(`handle-${inbox}`, async () => {
            const email = await ctx.redis.get<StoredEmail>(keys(prefix, tenant).email(email_id))
            if (!email) throw new Error(`Email ${email_id} is not stored`)
            // The run owns its claim: a retried step takes it back. Another
            // run of the same email leaves it to the owner.
            return handleEmail(ctx, email, inbox, {
              ...options,
              owner: context.workflowRunId,
              answerLatestOnly: !!followUp,
              forInbox: forInbox(email),
            })
          })
        }
      },
      { url: options.workflow?.url, receiver: options.workflow?.receiver },
    ).handler
  }

  /**
   * Pick up every event since the last catch-up, after downtime: mail that
   * arrived is stored and handed to `onEmail`, like the webhook would have,
   * and missed delivery outcomes are recorded. Events are read again from a
   * minute back, since an event can become readable just behind one already
   * read; acting on one twice is harmless. `since` overrides the saved
   * position, and is required the first time.
   */
  async function catchUp({ since }: { since?: string } = {}) {
    const cursorKey = `${prefix}:events:cursor`
    let cursor = since ?? (await ctx.redis.get<string>(cursorKey))
    if (!cursor) throw new Error("Pass `since` on the first catch-up")
    let count = 0
    for await (const event of ctx.aiinbx.events.list({
      order: "asc",
      type: EVENT_TYPES,
      after: minuteBefore(cursor),
    })) {
      // Still being handled elsewhere: stop here, and the next catch-up
      // starts from this event again.
      if (!(await dispatch(event))) break
      cursor = event.created_at
      await ctx.redis.set(cursorKey, cursor)
      count++
    }
    return { count, cursor }
  }

  /**
   * Store the mail that was there before the kit: every email created since
   * the last backfill, oldest first. Only stores: an agent should not answer
   * months of old mail. `since` overrides the saved position.
   */
  async function backfill({ since }: { since?: string } = {}) {
    const cursorKey = `${prefix}:backfill:cursor`
    let cursor = since ?? (await ctx.redis.get<string>(cursorKey))
    let count = 0
    for await (const email of ctx.aiinbx.emails.list({
      order: "asc",
      limit: 100,
      ...(cursor && { after: minuteBefore(cursor) }),
    })) {
      if (email.status === "draft" || email.status === "scheduled") continue
      await enqueue(
        { email_id: email.id, hints: {}, handle: false },
        { spaceId: email.space_id, threadId: email.thread_id },
      )
      cursor = email.created_at
      await ctx.redis.set(cursorKey, cursor)
      count++
    }
    return { count, cursor }
  }

  /**
   * Delete everything stored for a tenant: its mail, files and vectors. For a
   * customer who leaves. Mail at AI Inbx stays; delete the space there too.
   */
  async function deleteTenant(tenant: string): Promise<void> {
    assertName("tenant", tenant)
    const k = keys(prefix, tenant)
    const inboxPrefix = k.inbox("")
    const addresses = new Set<string>()
    let cursor = "0"
    do {
      const [next, found] = await ctx.redis.scan(cursor, { match: k.all, count: 1_000 })
      for (const key of found) {
        // `…:inbox:{address}` and its sub-keys name the tenant's addresses.
        const address = key.startsWith(inboxPrefix) && key.slice(inboxPrefix.length).split(":")[0]
        if (address && address !== ALL_INBOXES) addresses.add(address)
      }
      if (found.length) await ctx.redis.del(...found)
      cursor = String(next)
    } while (cursor !== "0")
    // The address stays ours while another tenant still uses it.
    for (const address of addresses) await ctx.redis.srem(addressKey(prefix, address), tenant)
    await ctx.bucket.del({ prefix: blobPaths(prefix, tenant).all })
    await ctx.index.deleteNamespace(vectorNamespace(prefix, tenant)).catch((error: Error) => {
      // A tenant that never stored text has no namespace.
      if (!/not found|does not exist/i.test(error.message)) throw error
    })
  }

  return { ctx, scope, webhook, workflow, ingest, catchUp, backfill, deleteTenant }
}

interface WorkflowPayload {
  email_id: string
  hints: IngestHints
  handle: boolean
}

/** Runtimes without `process` (Workers) pass every client and secret explicitly. */
function env(name: string): string | undefined {
  return globalThis.process?.env?.[name]
}

/**
 * A list position a minute back: something can become readable just behind
 * what was already read, and reading it twice is harmless.
 */
function minuteBefore(instant: string): string {
  return new Date(Date.parse(instant) - 60_000).toISOString()
}
