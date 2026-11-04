import type { EmailStatus } from "aiinbx"
import type { Redis } from "@upstash/redis"

/**
 * An email's status only moves forward, whatever order the news arrives in:
 * a late `sent` never undoes `delivered`, and storing an email again can
 * still raise a status a missed event left behind. Kept as a sorted set
 * scored by stage; the highest member is the status.
 */
const STAGE: Record<EmailStatus, number> = {
  received: 0,
  draft: 0,
  scheduled: 1,
  queued: 2,
  sending: 3,
  sent: 4,
  canceled: 4,
  discarded: 4,
  delivered: 5,
  bounced: 6,
  failed: 6,
  complained: 7,
}

/** The member to `zadd` to an email's status key. */
export function statusEntry(status: EmailStatus) {
  return { score: STAGE[status], member: status }
}

export async function readStatus(redis: Redis, key: string): Promise<EmailStatus | null> {
  const [status] = await redis.zrange<EmailStatus[]>(key, 0, 0, { rev: true })
  return status ?? null
}
