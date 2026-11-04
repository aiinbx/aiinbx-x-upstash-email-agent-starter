import type AIInbx from "aiinbx"
import { ConflictError, NotFoundError, type FullEmail } from "aiinbx"

/**
 * An in-memory stand-in for the AI Inbx client: the parts the kit calls.
 * Lets the integration tests run against real Upstash without mail delivery.
 */
export function fakeAIInbx() {
  const emails = new Map<string, FullEmail>()
  const files = new Map<string, { bytes: Uint8Array | null; text: string | null }>()
  const calls = { send: [] as unknown[], reply: [] as unknown[] }
  /** Like the API: a repeated key replays the first send, a changed body is refused. */
  const keys = new Map<string, { body: string; result: unknown }>()
  async function idempotent<T>(key: string | undefined, body: unknown, send: () => T): Promise<T> {
    if (!key) return send()
    const seen = keys.get(key)
    if (seen && seen.body !== JSON.stringify(body)) {
      throw new ConflictError(
        409,
        { code: "idempotency_key_reused", detail: "reused" },
        null,
        new Headers(),
      )
    }
    if (seen) return seen.result as T
    const result = send()
    keys.set(key, { body: JSON.stringify(body), result })
    return result
  }
  let seq = 0

  function add(email: Partial<FullEmail> & Pick<FullEmail, "id" | "thread_id">): FullEmail {
    const full: FullEmail = {
      space_id: null,
      direction: "inbound",
      status: "received",
      from: { name: null, address: "someone@example.com" },
      to: [],
      cc: [],
      bcc: [],
      reply_to: [],
      subject: "",
      snippet: "",
      html: null,
      text: null,
      category: "human",
      verdicts: null,
      suppression_key: null,
      message_id: `${email.id}@example.com`,
      in_reply_to: null,
      idempotency_key: null,
      created_at: new Date().toISOString(),
      scheduled_at: null,
      sent_at: null,
      draft: null,
      attachments: [],
      stripped_text: null,
      stripped_html: null,
      segments: [],
      references: [],
      headers: [],
      events: [],
      engagements: [],
      ...email,
    } as FullEmail
    emails.set(full.id, full)
    return full
  }

  function addAttachment(
    emailId: string,
    file: {
      id: string
      filename: string
      content_type: string
      /** Null: AI Inbx no longer has the bytes. */
      bytes: Uint8Array | null
      text: string | null
    },
  ) {
    const email = emails.get(emailId)!
    files.set(file.id, { bytes: file.bytes, text: file.text })
    email.attachments.push({
      id: file.id,
      filename: file.filename,
      content_type: file.content_type,
      size: file.bytes?.byteLength ?? 1_000,
      cid: null,
      download_url: file.bytes ? "https://storage.example/signed" : null,
      expires_at: null,
      preparation: file.text
        ? {
            status: "ready",
            format: "markdown",
            pages: 1,
            warnings: [],
            content_url: null,
            text: file.text,
          }
        : {
            status: "unsupported",
            format: null,
            pages: null,
            warnings: [],
            content_url: null,
            text: null,
          },
    })
  }

  function outbound(
    body: {
      from: unknown
      text: string
      subject?: string
      to?: string | string[]
      draft?: boolean
    },
    threadId: string,
  ) {
    const from =
      typeof body.from === "string" ? { address: body.from } : (body.from as { address: string })
    const email = add({
      id: `eml_out_${++seq}`,
      thread_id: threadId,
      direction: "outbound",
      status: body.draft ? "draft" : "queued",
      from: { name: null, address: from.address },
      to: typeof body.to === "string" ? [body.to] : (body.to ?? []),
      subject: body.subject ?? "Re: thread",
      text: body.text,
      stripped_text: body.text,
    })
    return { ...email, suppressed: [], pacing: null }
  }

  const client = {
    emails: {
      retrieve: async (id: string) => {
        const email = emails.get(id)
        if (!email) throw new Error(`no email ${id}`)
        return structuredClone(email)
      },
      update: async (id: string, changes: Partial<FullEmail>) => {
        const email = emails.get(id)!
        Object.assign(email, changes, changes.text ? { stripped_text: changes.text } : {})
        return email
      },
      sendDraft: async (id: string) => {
        const email = emails.get(id)!
        email.status = "scheduled"
        return email
      },
      cancel: async (id: string) => {
        const email = emails.get(id)!
        email.status = email.status === "draft" ? "discarded" : "canceled"
        return email
      },
      list: async function* (query: { after?: string }) {
        const after = query.after ? Date.parse(query.after) : -Infinity
        yield* [...emails.values()]
          .filter((e) => Date.parse(e.created_at) > after)
          .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
      },
      send: async (
        body: { from: unknown; to: string[]; subject: string; text: string },
        options?: { idempotencyKey?: string },
      ) => {
        calls.send.push({ body, options })
        return idempotent(options?.idempotencyKey, body, () => outbound(body, `thr_new_${++seq}`))
      },
    },
    threads: {
      retrieve: async (id: string) => ({
        id,
        mailbox: [...emails.values()].find((e) => e.thread_id === id)?.to[0] ?? "",
      }),
      reply: async (
        threadId: string,
        body: { from: unknown; text: string },
        options?: { idempotencyKey?: string },
      ) => {
        calls.reply.push({ threadId, body, options })
        return idempotent(options?.idempotencyKey, { threadId, body }, () =>
          outbound(body, threadId),
        )
      },
    },
    attachments: {
      download: async (id: string) => {
        const bytes = files.get(id)!.bytes
        if (!bytes)
          throw new NotFoundError(404, { error: { code: "not_found" } }, null, new Headers())
        return bytes.slice().buffer
      },
      content: async (id: string) => files.get(id)!.text ?? "",
    },
  }

  return { client: client as unknown as AIInbx, add, addAttachment, calls }
}
