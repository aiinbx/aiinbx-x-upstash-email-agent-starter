import { keys, type Context } from "./context"
import type { Scope } from "./scope"
import type { EmailTool } from "./tools"
import type { StoredEmail } from "./types"

export interface HandlerArgs {
  email: StoredEmail
  /** The tenant the email belongs to: its AI Inbx space, or `default`. Load your customer's agent with it. */
  tenant: string
  /** The inbox the email reached. An email to two of our addresses is handled once for each. */
  inbox: string
  /** The tenant's mail as `inbox` sees it, for reads your code does itself. */
  scope: Scope
  /** The scope's tools. Sends repeated by a retry of this run go out once. */
  tools: EmailTool[]
}

export type EmailHandler = (args: HandlerArgs) => Promise<void>

/**
 * Decides whether `onEmail` runs for an email at an inbox. Filters for loops,
 * spam and floods are in `./addons`.
 */
export type EmailFilter = (args: {
  email: StoredEmail
  tenant: string
  inbox: string
  ctx: Context
}) => boolean | Promise<boolean>

export interface HandleOptions {
  onEmail?: EmailHandler
  /**
   * Which emails reach `onEmail`. Default: every received email. An agent
   * that answers on its own should at least skip auto-replies and mail from
   * its own inboxes (`skipCategories`, `skipOwnInboxes` in `./addons`), or
   * two machines can mail each other forever.
   */
  shouldHandle?: EmailFilter
}

export type HandleOutcome =
  "handled" | "no_handler" | "skipped" | "superseded" | "duplicate" | "in_progress"

/** How long a claim holds while its handler runs; a run that dies frees it after this. */
const LEASE_SECONDS = 15 * 60

/**
 * Run `onEmail` for one inbox of a stored email, at most once. Deliveries
 * repeat and race, so the email is claimed first, by its `owner`: the
 * workflow run, which may take its own claim back when a step is retried.
 * Any other caller gets `in_progress` while the claim holds. A handler that
 * throws frees the claim for the retry; a run that dies frees it when the
 * lease ends.
 */
export async function handleEmail(
  ctx: Context,
  email: StoredEmail,
  inbox: string,
  options: HandleOptions & {
    owner: string
    /** Leave an email to a newer one in its thread, whose run answers both. */
    answerLatestOnly?: boolean
    /** The scope and tools a handler gets for an inbox. */
    forInbox: (inbox: string) => Pick<HandlerArgs, "scope" | "tools">
  },
): Promise<HandleOutcome> {
  if (!options.onEmail) return "no_handler"
  if (email.direction !== "inbound") return "skipped"
  const { tenant } = email
  if (options.shouldHandle && !(await options.shouldHandle({ email, tenant, inbox, ctx }))) {
    return "skipped"
  }
  if (options.answerLatestOnly && (await hasNewerInbound(ctx, email, inbox))) return "superseded"

  const key = keys(ctx.prefix, tenant).handled(email.id, inbox)
  const mine = `running:${options.owner}`
  if (!(await ctx.redis.set(key, mine, { nx: true, ex: LEASE_SECONDS }))) {
    const state = await ctx.redis.get<string>(key)
    if (state === "done") return "duplicate"
    if (state !== mine) return "in_progress"
    await ctx.redis.expire(key, LEASE_SECONDS)
  }
  try {
    await options.onEmail({ email, tenant, inbox, ...options.forInbox(inbox) })
  } catch (error) {
    await ctx.redis.del(key)
    throw error
  }
  await ctx.redis.set(key, "done")
  return "handled"
}

/** Whether the inbox got a later message from the other side in the same thread. */
async function hasNewerInbound(ctx: Context, email: StoredEmail, inbox: string): Promise<boolean> {
  const k = keys(ctx.prefix, email.tenant)
  const newer = await ctx.redis.zrange<string[]>(
    k.inboxThread(inbox, email.thread_id),
    `(${Date.parse(email.created_at)}`,
    "+inf",
    { byScore: true },
  )
  const later = await Promise.all(newer.map((id) => ctx.redis.get<StoredEmail>(k.email(id))))
  return later.some((e) => e?.direction === "inbound")
}
