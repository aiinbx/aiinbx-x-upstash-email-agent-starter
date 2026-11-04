import {
  addressKey,
  ALL_INBOXES,
  assertName,
  DEFAULT_TENANT,
  keys,
  vectorNamespace,
  type Context,
} from "./context"
import { readStatus } from "./status"
import type { SearchHit, StoredAttachment, StoredEmail, ThreadSummary } from "./types"

export interface ScopeOptions {
  /** The tenant: an AI Inbx space id, or `default` for mail outside spaces. Default `default`. */
  tenant?: string
  /**
   * The inboxes this scope reads and sends as: one address (an agent), a
   * few (a team), or `"all"` of the tenant's (a dashboard, an admin agent).
   */
  inboxes: string | string[] | "all"
  /** Display name on mail sent from this scope. */
  name?: string
}

export interface SendRequest {
  /** Which inbox sends. Optional when the scope has exactly one. */
  from?: string
  to: string[]
  cc?: string[]
  subject: string
  text: string
  html?: string
  /** Save it for a person to review and send, instead of sending it. */
  draft?: boolean
  /** ISO 8601 time, at most 30 days ahead: AI Inbx holds the email until then. */
  sendAt?: string
}

export interface ReplyRequest {
  text: string
  html?: string
  /** Save it for a person to review and send, instead of sending it. */
  draft?: boolean
  /** ISO 8601 time, at most 30 days ahead: AI Inbx holds the email until then. */
  sendAt?: string
  /** Also answer everyone on the message replied to. */
  replyAll?: boolean
}

export interface SendOptions {
  idempotencyKey?: string
}

export class NotInScopeError extends Error {
  constructor(what: string) {
    super(`${what} is not in this scope`)
    this.name = "NotInScopeError"
  }
}

export type Scope = ReturnType<typeof createScope>

/**
 * A tenant's mail as some of its inboxes see it: the reads and actions an
 * agent's tools are built on, and that your own app can call the same way.
 * Nothing outside the scope exists for it: other tenants never, other
 * inboxes' messages not even on a shared thread.
 */
export function createScope(
  ctx: Context,
  /** Stores what the scope sends, so the next read shows it. */
  store: (emailId: string) => Promise<unknown>,
  options: ScopeOptions,
) {
  const tenant = options.tenant ?? DEFAULT_TENANT
  assertName("tenant", tenant)
  const all = options.inboxes === "all"
  const inboxes = all ? [] : [options.inboxes].flat().map((a) => a.toLowerCase())
  if (!all && inboxes.length === 0) throw new Error("A scope needs at least one inbox")
  const views = all ? [ALL_INBOXES] : inboxes
  const k = keys(ctx.prefix, tenant)
  const vector = ctx.index.namespace(vectorNamespace(ctx.prefix, tenant))

  const sender = (address: string) => (options.name ? { name: options.name, address } : address)
  const email = (id: string) => ctx.redis.get<StoredEmail>(k.email(id))

  /** The scope's messages of a thread, oldest first. */
  async function emailIds(threadId: string): Promise<string[]> {
    const lists = await Promise.all(
      views.map((v) =>
        ctx.redis.zrange<(string | number)[]>(k.inboxThread(v, threadId), 0, -1, {
          withScores: true,
        }),
      ),
    )
    return scored(lists)
      .sort((a, b) => a.score - b.score)
      .map((m) => m.id)
  }

  async function assertThread(threadId: string): Promise<void> {
    const scores = await Promise.all(views.map((v) => ctx.redis.zscore(k.inbox(v), threadId)))
    if (scores.every((s) => s === null)) throw new NotInScopeError(`Thread ${threadId}`)
  }

  async function assertSender(address: string): Promise<void> {
    const ours = all ? (await ctx.redis.exists(k.inbox(address))) === 1 : inboxes.includes(address)
    if (!ours) throw new NotInScopeError(`Inbox ${address}`)
  }

  /** The addresses that are none of our inboxes, in any tenant. */
  async function notOurs(addresses: string[]): Promise<string[]> {
    const ours = await Promise.all(
      addresses.map((a) => ctx.redis.exists(addressKey(ctx.prefix, a))),
    )
    return addresses.filter((_, i) => !ours[i])
  }

  async function assertPending(emailId: string, pending: "draft" | "scheduled"): Promise<void> {
    const [e, status] = await Promise.all([
      email(emailId),
      readStatus(ctx.redis, k.status(emailId)),
    ])
    const visible = e && (all || e.inboxes.some((i) => inboxes.includes(i)))
    const what = pending === "draft" ? "Draft" : "Scheduled email"
    if (!visible || status !== pending) throw new NotInScopeError(`${what} ${emailId}`)
  }

  const assertDraft = (emailId: string) => assertPending(emailId, "draft")

  async function summary(threadId: string, at: number): Promise<ThreadSummary> {
    const [meta, ids] = await Promise.all([
      ctx.redis.hgetall<Record<string, string>>(k.thread(threadId)),
      emailIds(threadId),
    ])
    const last = ids.length ? await email(ids[ids.length - 1]!) : null
    return {
      id: threadId,
      subject: meta?.subject ?? "",
      status: meta?.status ?? null,
      note: meta?.note ?? null,
      message_count: ids.length,
      last_message_at: new Date(at).toISOString(),
      last_message: last && {
        id: last.id,
        from: last.from.address,
        direction: last.direction,
        snippet: last.text.slice(0, 200),
      },
    }
  }

  return {
    tenant,
    inboxes: all ? ("all" as const) : inboxes,

    /** Conversations by latest activity. `before` pages back; `status` filters. */
    async listThreads(
      options: { limit?: number; before?: string; status?: string } = {},
    ): Promise<ThreadSummary[]> {
      const limit = options.limit ?? 20
      const max = options.before ? (`(${Date.parse(options.before)}` as const) : "+inf"
      // A status filter reads further back to fill the page, within a bound.
      const count = options.status ? Math.min(limit * 10, 500) : limit
      const lists = await Promise.all(
        views.map((v) =>
          ctx.redis.zrange<(string | number)[]>(k.inbox(v), max, "-inf", {
            byScore: true,
            rev: true,
            offset: 0,
            count,
            withScores: true,
          }),
        ),
      )
      const threads = scored(lists)
        .sort((a, b) => b.score - a.score)
        .slice(0, count)
      const summaries = await Promise.all(threads.map((t) => summary(t.id, t.score)))
      return summaries.filter((t) => !options.status || t.status === options.status).slice(0, limit)
    },

    /** A thread's messages in this scope, oldest first; `limit` keeps the latest. */
    async getThread(threadId: string, options: { limit?: number } = {}) {
      await assertThread(threadId)
      const [meta, ids] = await Promise.all([
        ctx.redis.hgetall<Record<string, string>>(k.thread(threadId)),
        emailIds(threadId),
      ])
      const latest = ids.slice(-(options.limit ?? 20))
      const pipeline = ctx.redis.pipeline()
      for (const id of latest) {
        pipeline.get(k.email(id))
        pipeline.zrange(k.status(id), 0, 0, { rev: true })
      }
      const rows = latest.length ? await pipeline.exec<(StoredEmail | string[] | null)[]>() : []
      const max = ctx.limits.maxCharsPerMessage
      const messages = latest.flatMap((_, i) => {
        const e = rows[i * 2] as StoredEmail | null
        if (!e) return []
        const text =
          e.text.length > max
            ? `${e.text.slice(0, max)}\n[… ${e.text.length - max} more characters]`
            : e.text
        return [
          {
            id: e.id,
            direction: e.direction,
            status: e.direction === "outbound" ? ((rows[i * 2 + 1] as string[])[0] ?? null) : null,
            from: e.from,
            to: e.to,
            cc: e.cc,
            subject: e.subject,
            created_at: e.created_at,
            category: e.category,
            text,
            attachments: e.attachments,
          },
        ]
      })
      return {
        id: threadId,
        subject: meta?.subject ?? messages[0]?.subject ?? "",
        status: meta?.status ?? null,
        note: meta?.note ?? null,
        message_count: ids.length,
        messages,
      }
    },

    /** Semantic and keyword search over bodies and attachment contents. */
    async search(options: {
      query: string
      limit?: number
      thread_id?: string
      from?: string
      after?: string
      before?: string
    }): Promise<SearchHit[]> {
      const limit = options.limit ?? 8
      const filter: string[] = []
      if (!all) filter.push(`(${inboxes.map((i) => `inboxes CONTAINS ${quote(i)}`).join(" OR ")})`)
      if (options.thread_id) filter.push(`thread_id = ${quote(options.thread_id)}`)
      if (options.from) filter.push(`from = ${quote(options.from.toLowerCase())}`)
      if (options.after) filter.push(`created_at >= ${seconds(options.after)}`)
      if (options.before) filter.push(`created_at < ${seconds(options.before)}`)
      const results = await vector.query({
        data: options.query,
        // Several chunks of one document can match; ask for more, keep the best each.
        topK: limit * 3,
        includeMetadata: true,
        includeData: true,
        ...(filter.length && { filter: filter.join(" AND ") }),
      })
      const best = new Map<string, SearchHit>()
      for (const r of results) {
        const m = r.metadata
        if (!m) continue
        const key = `${m.email_id}#${m.attachment_id ?? "body"}`
        if (best.has(key)) continue
        best.set(key, {
          email_id: m.email_id,
          thread_id: m.thread_id,
          from: m.from,
          subject: m.subject,
          created_at: new Date(m.created_at * 1000).toISOString(),
          source: m.source,
          attachment_id: m.attachment_id,
          filename: m.filename,
          excerpt: r.data ?? "",
          score: r.score,
        })
      }
      return [...best.values()].slice(0, limit)
    },

    /** An attachment's text, in parts; a short-lived download link when it has none. */
    async readAttachment(
      attachmentId: string,
      options: { offset?: number; maxChars?: number } = {},
    ) {
      const a = await ctx.redis.get<StoredAttachment>(k.attachment(attachmentId))
      if (!a || (!all && !a.inboxes.some((i) => inboxes.includes(i)))) {
        throw new NotInScopeError(`Attachment ${attachmentId}`)
      }
      const meta = {
        id: a.id,
        filename: a.filename,
        content_type: a.content_type,
        size: a.size,
        email_id: a.email_id,
      }
      if (!a.text_path) {
        return {
          ...meta,
          text: null,
          note: `No text could be extracted from this file (${a.text_status ?? "not prepared"}).`,
          download_url: a.blob_path
            ? (await ctx.bucket.signedReadUrl(a.blob_path, { downloadAs: a.filename })).url
            : null,
        }
      }
      const full = await new Response((await ctx.bucket.get(a.text_path)).body).text()
      const offset = options.offset ?? 0
      const text = full.slice(offset, offset + (options.maxChars ?? 20_000))
      const end = offset + text.length
      return {
        ...meta,
        text,
        total_chars: full.length,
        next_offset: end < full.length ? end : null,
      }
    },

    /** Where a conversation stands, with a note for later; shared by the tenant's scopes. */
    async setStatus(threadId: string, status: string, note?: string): Promise<void> {
      await assertThread(threadId)
      await ctx.redis.hset(k.thread(threadId), {
        status,
        ...(note !== undefined && { note }),
        updated_at: new Date().toISOString(),
      })
    },

    /**
     * Drafts the scope's agents wrote, newest first: what your app shows a
     * person to approve when the agent runs with `drafts: true`.
     */
    async listDrafts(options: { limit?: number } = {}) {
      const lists = await Promise.all(
        views.map((v) =>
          ctx.redis.zrange<(string | number)[]>(k.drafts(v), 0, (options.limit ?? 20) - 1, {
            rev: true,
            withScores: true,
          }),
        ),
      )
      const ids = scored(lists)
        .sort((a, b) => b.score - a.score)
        .slice(0, options.limit ?? 20)
      const drafts = await Promise.all(ids.map((m) => email(m.id)))
      return drafts.flatMap((d) =>
        d
          ? [
              {
                id: d.id,
                thread_id: d.thread_id,
                from: d.from,
                to: d.to,
                cc: d.cc,
                subject: d.subject,
                text: d.text,
                created_at: d.created_at,
              },
            ]
          : [],
      )
    },

    /** Change a draft before it goes: recipients, subject or text. */
    async updateDraft(
      emailId: string,
      changes: { to?: string[]; cc?: string[]; subject?: string; text?: string; html?: string },
    ) {
      await assertDraft(emailId)
      await ctx.aiinbx.emails.update(emailId, changes)
      await store(emailId)
    },

    /** Send a draft a person approved. */
    async sendDraft(emailId: string) {
      await assertDraft(emailId)
      const sent = await ctx.aiinbx.emails.sendDraft(emailId)
      await store(emailId)
      return { id: sent.id, thread_id: sent.thread_id, status: sent.status }
    },

    /** Throw a draft away. */
    async discardDraft(emailId: string) {
      await assertDraft(emailId)
      await ctx.aiinbx.emails.cancel(emailId)
      await store(emailId)
    },

    /** Cancel an email the scope scheduled, before it goes out. */
    async cancelScheduled(emailId: string) {
      await assertPending(emailId, "scheduled")
      await ctx.aiinbx.emails.cancel(emailId)
      await store(emailId)
      return { id: emailId, status: "canceled" as const }
    },

    /** Start a conversation from one of the scope's inboxes. */
    async send(request: SendRequest, options: SendOptions = {}) {
      const from = (request.from ?? (inboxes.length === 1 ? inboxes[0] : undefined))?.toLowerCase()
      if (!from) throw new Error("Say which inbox to send from")
      await assertSender(from)
      const { from: _, sendAt, ...body } = request
      const sent = await ctx.aiinbx.emails.send(
        { ...body, from: sender(from), ...(sendAt && { scheduled_at: sendAt }) },
        options,
      )
      await store(sent.id)
      return sendResult(sent)
    },

    /**
     * Answer the latest message of a thread this scope saw, from the inbox it
     * went through, honouring Reply-To.
     */
    async reply(threadId: string, request: ReplyRequest, options: SendOptions = {}) {
      await assertThread(threadId)
      const ids = await emailIds(threadId)
      const latest = ids.length ? await email(ids[ids.length - 1]!) : null
      if (!latest) throw new Error(`Thread ${threadId} has no messages in this scope yet`)
      const from =
        latest.direction === "outbound"
          ? latest.from.address
          : (all ? latest.inboxes : latest.inboxes.filter((i) => inboxes.includes(i)))[0]!
      // AI Inbx works out the recipients from the thread. Only a Reply-To,
      // which it does not follow, has to be said: then the reply goes there,
      // and on reply-all the others it was sent to are copied.
      const replyTo = latest.direction === "inbound" ? latest.reply_to : []
      const others =
        replyTo.length && request.replyAll ? await notOurs(latest.to.filter((a) => a !== from)) : []
      const sent = await ctx.aiinbx.threads.reply(
        threadId,
        {
          from: sender(from),
          reply_all: request.replyAll ?? false,
          ...(replyTo.length && { to: replyTo }),
          ...(others.length && { cc: others }),
          text: request.text,
          html: request.html,
          draft: request.draft,
          ...(request.sendAt && { scheduled_at: request.sendAt }),
        },
        options,
      )
      await store(sent.id)
      return sendResult(sent)
    },
  }
}

/** Members of several sorted sets, each once at its highest score. */
function scored(lists: (string | number)[][]): { id: string; score: number }[] {
  const best = new Map<string, number>()
  for (const list of lists) {
    for (let i = 0; i < list.length; i += 2) {
      const id = String(list[i])
      const score = Number(list[i + 1])
      if (!(best.get(id)! >= score)) best.set(id, score)
    }
  }
  return [...best].map(([id, score]) => ({ id, score }))
}

/** Filter values are quoted strings; refuse what could break out of one. */
function quote(value: string): string {
  if (/['\\]/.test(value)) throw new Error(`Unsupported character in filter value: ${value}`)
  return `'${value}'`
}

function seconds(iso: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new Error(`Not an ISO 8601 date: ${iso}`)
  return Math.floor(ms / 1000)
}

/**
 * What the agent learns from a send. `suppressed` lists recipients AI Inbx
 * dropped because they bounced, complained or unsubscribed.
 */
function sendResult(sent: { id: string; thread_id: string; status: string; suppressed: string[] }) {
  return {
    id: sent.id,
    thread_id: sent.thread_id,
    status: sent.status,
    ...(sent.suppressed.length && { suppressed: sent.suppressed }),
  }
}
