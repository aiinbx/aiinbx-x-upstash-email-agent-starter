/**
 * Optional filters for `shouldHandle`. None run unless you add them:
 *
 *   createEmailKit({
 *     shouldHandle: allOf(
 *       skipCategories("auto_reply", "out_of_office", "bounce", "spam"),
 *       skipOwnInboxes,
 *       skipFailedDmarc,
 *       senderLimit({ max: 20, windowSeconds: 3600 }),
 *     ),
 *   })
 */
import type { EmailCategory } from "aiinbx"
import { addressKey } from "../context"
import type { EmailFilter } from "../handle"

/** Every filter must pass. */
export function allOf(...filters: EmailFilter[]): EmailFilter {
  return async (args) => {
    for (const filter of filters) if (!(await filter(args))) return false
    return true
  }
}

/**
 * Skip mail AI Inbx classified as one of these. An agent that replies to
 * auto-replies, out-of-office notes or bounces is how mail loops start.
 */
export function skipCategories(...categories: EmailCategory[]): EmailFilter {
  return ({ email }) => !email.category || !categories.includes(email.category)
}

/**
 * Skip mail from any of our own inboxes, in any tenant, so two agents don't
 * answer each other forever.
 */
export const skipOwnInboxes: EmailFilter = async ({ email, ctx }) =>
  !(await ctx.redis.exists(addressKey(ctx.prefix, email.from.address)))

/**
 * Skip received mail whose DMARC check failed: its From address is not
 * backed by the sender's domain, so it may only claim to be from someone.
 */
export const skipFailedDmarc: EmailFilter = ({ email }) => email.verdicts?.dmarc !== "FAIL"

/**
 * Handle at most `max` emails per sender and inbox in each window; the rest
 * are only stored. Keeps a misbehaving sender from running up a model bill.
 * Each email counts once, however often its delivery is retried.
 */
export function senderLimit(limit: { max: number; windowSeconds: number }): EmailFilter {
  return async ({ email, tenant, inbox, ctx }) => {
    const window = Math.floor(Date.now() / 1000 / limit.windowSeconds)
    const key = `${ctx.prefix}:${tenant}:sender-limit:${inbox}:${email.from.address}:${window}`
    const [, , rank] = await ctx.redis
      .multi()
      .zadd(key, { nx: true }, { score: Date.now(), member: email.id })
      .expire(key, limit.windowSeconds * 2)
      .zrank(key, email.id)
      .exec<[number, number, number | null]>()
    return rank !== null && rank < limit.max
  }
}
