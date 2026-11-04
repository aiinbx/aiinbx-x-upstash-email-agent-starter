import { NotFoundError, type FullEmail } from "aiinbx"
import { chunk } from "./chunk"
import {
  addressesKey,
  ALL_INBOXES,
  blobPaths,
  keys,
  vectorNamespace,
  type ChunkMetadata,
  type Context,
} from "./context"
import type { StoredAttachment, StoredEmail } from "./types"

/** What the webhook knows that the email itself does not. */
export interface IngestHints {
  /**
   * Envelope recipients of mail received on one of our domains: exactly the
   * addresses it was delivered to, Bcc included, and nobody it merely names.
   */
  recipients?: string[]
}

/** The attachments an ingest copies, small enough to pass between workflow steps. */
export interface AttachmentJob {
  tenant: string
  email_id: string
  id: string
  filename: string
  content_type: string
  size: number
  /** False when AI Inbx no longer has the bytes. */
  available: boolean
  prepared: boolean
}

/**
 * Store one email: attachments to Blob, text to Vector, the record to Redis
 * last, so whatever Redis points at already exists. Every write is keyed by
 * AI Inbx ids, so storing an email again changes nothing.
 */
export async function ingestEmail(
  ctx: Context,
  emailId: string,
  hints: IngestHints = {},
): Promise<StoredEmail> {
  for (const job of await planAttachments(ctx, emailId)) {
    await copyAttachment(ctx, job)
  }
  return saveEmail(ctx, emailId, hints)
}

export async function planAttachments(ctx: Context, emailId: string): Promise<AttachmentJob[]> {
  const email = await ctx.aiinbx.emails.retrieve(emailId)
  const tenant = ctx.tenantOf(email.space_id)
  return email.attachments.map((a) => ({
    tenant,
    email_id: email.id,
    id: a.id,
    filename: a.filename,
    content_type: a.content_type,
    size: a.size,
    available: a.download_url !== null,
    prepared: hasText(a.preparation),
  }))
}

/** Copy what AI Inbx still has. A file it has lost is skipped, never retried forever. */
export async function copyAttachment(ctx: Context, job: AttachmentJob): Promise<void> {
  const paths = blobPaths(ctx.prefix, job.tenant)
  if (job.available) {
    // A freshly signed link, streamed straight into Blob: no file is held in
    // memory, whatever its size.
    const email = await ctx.aiinbx.emails.retrieve(job.email_id)
    const url = email.attachments.find((a) => a.id === job.id)?.download_url
    if (url) {
      const response = await fetch(url)
      if (!response.ok || !response.body) {
        throw new Error(`Downloading attachment ${job.id} failed with ${response.status}`)
      }
      await ctx.bucket.put(paths.file(job.id, job.filename), response.body, {
        contentType: job.content_type,
        size: job.size,
      })
    }
  }
  if (job.prepared) {
    const text = await unlessGone(ctx.aiinbx.attachments.content(job.id))
    if (text)
      await ctx.bucket.put(paths.text(job.id), text, {
        contentType: "text/markdown; charset=utf-8",
      })
  }
}

async function unlessGone<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request
  } catch (error) {
    if (error instanceof NotFoundError) return null
    throw error
  }
}

export async function saveEmail(
  ctx: Context,
  emailId: string,
  hints: IngestHints = {},
): Promise<StoredEmail> {
  const email = await ctx.aiinbx.emails.retrieve(emailId, { include: ["attachment_content"] })
  const tenant = ctx.tenantOf(email.space_id)
  const k = keys(ctx.prefix, tenant)
  const [existing, status] = await Promise.all([
    ctx.redis.get<StoredEmail>(k.email(emailId)),
    ctx.redis.get<string>(k.status(emailId)),
  ])
  // Storing again never narrows who sees an email: a backfill knows less
  // than the webhook that stored it first.
  const inboxes = [
    ...new Set([...(existing?.inboxes ?? []), ...(await inboxesOf(ctx, email, hints))]),
  ].sort()
  const attachments = await Promise.all(
    email.attachments.map((a) => storedAttachment(ctx, tenant, email, a, inboxes)),
  )
  const stored = toStored(email, tenant, inboxes, attachments)

  if (email.html) {
    await ctx.bucket.put(blobPaths(ctx.prefix, tenant).html(email.id), email.html, {
      contentType: "text/html; charset=utf-8",
    })
  }
  await indexEmail(ctx, email, stored)
  // Delivery events may already have set a later status; a draft's status
  // only ever moves on by being sent or discarded, which the API knows.
  const latest = !status || status === "draft" ? email.status : null
  await writeRecords(ctx, email, stored, attachments, latest)
  return stored
}

/**
 * The inboxes an email went through: the sender of what we sent; for
 * received mail the envelope recipients, or else the thread's mailbox.
 * Never the addresses a message merely names in To or Cc: those can be
 * anyone's, and an agent must not end up acting as them.
 */
async function inboxesOf(ctx: Context, email: FullEmail, hints: IngestHints): Promise<string[]> {
  if (email.direction === "outbound") return [email.from.address.toLowerCase()]
  if (hints.recipients?.length) return hints.recipients.map((a) => a.toLowerCase())
  const thread = await ctx.aiinbx.threads.retrieve(email.thread_id, { message_limit: 1 })
  return [thread.mailbox.toLowerCase()]
}

async function storedAttachment(
  ctx: Context,
  tenant: string,
  email: FullEmail,
  a: FullEmail["attachments"][number],
  inboxes: string[],
): Promise<StoredAttachment> {
  const paths = blobPaths(ctx.prefix, tenant)
  const [file, text] = await Promise.all([
    ctx.bucket.exists(paths.file(a.id, a.filename)),
    ctx.bucket.exists(paths.text(a.id)),
  ])
  return {
    id: a.id,
    filename: a.filename,
    content_type: a.content_type,
    size: a.size,
    has_text: text,
    email_id: email.id,
    thread_id: email.thread_id,
    inboxes,
    blob_path: file ? paths.file(a.id, a.filename) : null,
    text_path: text ? paths.text(a.id) : null,
    text_status: a.preparation?.status ?? null,
  }
}

function toStored(
  email: FullEmail,
  tenant: string,
  inboxes: string[],
  attachments: StoredAttachment[],
): StoredEmail {
  return {
    id: email.id,
    thread_id: email.thread_id,
    tenant,
    space_id: email.space_id,
    direction: email.direction === "outbound" ? "outbound" : "inbound",
    from: { name: email.from.name ?? null, address: email.from.address.toLowerCase() },
    to: email.to.map((a) => a.toLowerCase()),
    cc: email.cc.map((a) => a.toLowerCase()),
    reply_to: email.reply_to.map((a) => a.toLowerCase()),
    subject: email.subject,
    text: (email.stripped_text ?? email.text ?? email.snippet).trim(),
    category: email.category,
    message_id: email.message_id,
    in_reply_to: email.in_reply_to,
    created_at: email.created_at,
    inboxes,
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      content_type: a.content_type,
      size: a.size,
      has_text: a.has_text,
    })),
  }
}

function hasText(preparation: FullEmail["attachments"][number]["preparation"]): boolean {
  return (
    !!preparation &&
    (preparation.status === "ready" || preparation.status === "partial") &&
    preparation.format !== null
  )
}

async function indexEmail(ctx: Context, email: FullEmail, stored: StoredEmail): Promise<void> {
  const base = {
    email_id: email.id,
    thread_id: email.thread_id,
    inboxes: stored.inboxes,
    from: stored.from.address,
    subject: email.subject,
    created_at: Math.floor(Date.parse(email.created_at) / 1000),
  }
  const sender = stored.from.name
    ? `${stored.from.name} <${stored.from.address}>`
    : stored.from.address
  const header = `From: ${sender}\nSubject: ${email.subject}\n\n`
  const max = ctx.limits.maxChunksPerDocument
  const vectors: { id: string; data: string; metadata: ChunkMetadata }[] = []

  chunk(stored.text, max).forEach((text, i) =>
    vectors.push({
      id: `${email.id}#body#${i}`,
      data: header + text,
      metadata: { ...base, source: "body", attachment_id: null, filename: null },
    }),
  )
  for (const a of email.attachments) {
    if (!hasText(a.preparation)) continue
    const text = a.preparation?.text ?? (await unlessGone(ctx.aiinbx.attachments.content(a.id)))
    if (!text) continue
    chunk(text, max).forEach((part, i) =>
      vectors.push({
        id: `${email.id}#${a.id}#${i}`,
        data: `${header}Attachment: ${a.filename}\n\n${part}`,
        metadata: { ...base, source: "attachment", attachment_id: a.id, filename: a.filename },
      }),
    )
  }
  const vector = ctx.index.namespace(vectorNamespace(ctx.prefix, stored.tenant))
  for (let i = 0; i < vectors.length; i += 100) {
    await vector.upsert(vectors.slice(i, i + 100))
  }
}

async function writeRecords(
  ctx: Context,
  email: FullEmail,
  stored: StoredEmail,
  attachments: StoredAttachment[],
  status: string | null,
): Promise<void> {
  const k = keys(ctx.prefix, stored.tenant)
  const at = Date.parse(email.created_at)
  const tx = ctx.redis.multi()
  tx.set(k.email(email.id), stored)
  if (status) tx.set(k.status(email.id), status)
  for (const a of attachments) tx.set(k.attachment(a.id), a)
  tx.hsetnx(k.thread(email.thread_id), "subject", email.subject)
  tx.sadd(addressesKey(ctx.prefix), stored.inboxes[0]!, ...stored.inboxes.slice(1))
  for (const inbox of [...stored.inboxes, ALL_INBOXES]) {
    tx.zadd(k.inbox(inbox), { gt: true }, { score: at, member: email.thread_id })
    tx.zadd(k.inboxThread(inbox, email.thread_id), { score: at, member: email.id })
    if (email.status === "draft") tx.zadd(k.drafts(inbox), { score: at, member: email.id })
    else tx.zrem(k.drafts(inbox), email.id)
  }
  await tx.exec()
}
