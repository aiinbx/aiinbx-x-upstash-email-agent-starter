import { ConflictError } from "aiinbx"
import { z } from "zod"
import type { Scope, SendOptions } from "./scope"

/**
 * One tool, written once and handed to any agent framework through
 * `./adapters`. Schemas follow what every framework accepts: an object root,
 * `.optional()` instead of `.default()`, no transforms.
 */
export interface EmailTool<S extends z.ZodObject = z.ZodObject> {
  name: string
  description: string
  input: S
  execute(input: z.infer<S>): Promise<unknown>
}

function defineTool<S extends z.ZodObject>(tool: EmailTool<S>): EmailTool {
  return tool as unknown as EmailTool
}

export interface EmailToolsOptions {
  /**
   * One id per agent run, such as the email being handled. Within it, the
   * agent sends at most one reply per thread and one new email per set of
   * recipients, whatever the wording: a run retried after a crash, whose
   * model writes the reply differently, cannot mail twice. `onEmail` gets
   * tools with this set to the email's id.
   */
  idempotencyScope?: string
  /**
   * Save what the agent writes as drafts for a person to review and send,
   * instead of sending it. The safe start for an agent that reads mail from
   * strangers: a message can try to talk it into anything.
   */
  drafts?: boolean
}

/** The scope's reads and actions as agent tools. They see nothing outside the scope. */
export function createEmailTools(scope: Scope, options: EmailToolsOptions = {}): EmailTool[] {
  /**
   * The key that makes a send happen once per run. AI Inbx replays the first
   * send for a repeated key, and refuses one whose content changed.
   */
  async function once(...target: unknown[]): Promise<SendOptions> {
    if (!options.idempotencyScope) return {}
    const bytes = new TextEncoder().encode(
      JSON.stringify([options.idempotencyScope, scope.tenant, scope.inboxes, target]),
    )
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    return { idempotencyKey: Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("") }
  }

  async function sending<T>(send: Promise<T>, already: string): Promise<T> {
    try {
      return await send
    } catch (error) {
      if (error instanceof ConflictError && error.code === "idempotency_key_reused") {
        throw new Error(already)
      }
      throw error
    }
  }

  const drafted = options.drafts
    ? " It is saved as a draft for a person to review and send, not sent right away."
    : ""

  const sendAt = z
    .string()
    .optional()
    .describe(
      "ISO 8601 time, at most 30 days ahead, to send it later instead of now: a follow-up or a reminder. Cancel it with cancel_scheduled.",
    )

  const inboxes = scope.inboxes === "all" ? "any inbox of yours" : scope.inboxes.join(", ")

  return [
    defineTool({
      name: "list_threads",
      description:
        "List conversations, most recent activity first, with each thread's subject, status, message count and latest message.",
      input: z.object({
        status: z
          .string()
          .optional()
          .describe("Only threads with this status, as set by set_thread_status."),
        limit: z.number().int().min(1).max(50).optional().describe("How many threads. Default 20."),
        before: z
          .string()
          .optional()
          .describe("ISO 8601 time: only threads last active before it, to page back."),
      }),
      execute: (input) => scope.listThreads(input),
    }),

    defineTool({
      name: "get_thread",
      description:
        "Read a conversation: every message oldest first, with sender, recipients, what each message says (quoted replies removed), delivery status of sent mail, and attachments.",
      input: z.object({
        thread_id: z.string().describe("The thread id, thr_…"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Only the latest this many messages. Default 20."),
      }),
      execute: ({ thread_id, limit }) => scope.getThread(thread_id, { limit }),
    }),

    defineTool({
      name: "search_emails",
      description:
        "Search by meaning and keywords across email bodies and attachment contents (PDFs, documents). Returns the best matching passages with their email and thread.",
      input: z.object({
        query: z.string().min(1).describe("What to look for, in natural language or exact terms."),
        thread_id: z.string().optional().describe("Only within this thread."),
        from: z.string().optional().describe("Only mail from this address."),
        after: z.string().optional().describe("ISO 8601 time: only mail from then on."),
        before: z.string().optional().describe("ISO 8601 time: only mail before then."),
        limit: z.number().int().min(1).max(20).optional().describe("How many results. Default 8."),
      }),
      execute: (input) => scope.search(input),
    }),

    defineTool({
      name: "read_attachment",
      description:
        "Read an attachment's contents as Markdown or text. Long files come in parts: pass next_offset back as offset to continue. Files without text return a short-lived download link instead.",
      input: z.object({
        attachment_id: z.string().describe("The attachment id, att_…"),
        offset: z.number().int().min(0).optional().describe("Character to start at. Default 0."),
        max_chars: z
          .number()
          .int()
          .min(500)
          .max(50_000)
          .optional()
          .describe("Characters to return. Default 20000."),
      }),
      execute: ({ attachment_id, offset, max_chars }) =>
        scope.readAttachment(attachment_id, { offset, maxChars: max_chars }),
    }),

    defineTool({
      name: "send_email",
      description: `Start a new conversation by sending an email. You send as ${inboxes}.${drafted}`,
      input: z.object({
        from: z
          .string()
          .optional()
          .describe("Which of your inboxes sends. Only needed when you have several."),
        to: z.array(z.string()).min(1).describe("Recipient addresses."),
        cc: z.array(z.string()).optional().describe("Cc addresses."),
        subject: z.string().min(1),
        text: z.string().min(1).describe("The message, plain text."),
        send_at: sendAt,
      }),
      execute: async ({ send_at, ...input }) =>
        sending(
          scope.send(
            { ...input, sendAt: send_at, draft: options.drafts },
            await once(
              "send",
              [...input.to, ...(input.cc ?? [])].map((a) => a.toLowerCase()).sort(),
              send_at ?? null,
            ),
          ),
          "You already sent these recipients an email in this run.",
        ),
    }),

    defineTool({
      name: "reply",
      description:
        "Reply in a conversation. Goes to the sender of the latest message you have in it (or, if that was you, to whom it went), from the inbox it went through, threaded with the right subject and headers." +
        drafted,
      input: z.object({
        thread_id: z.string().describe("The thread id, thr_…"),
        text: z
          .string()
          .min(1)
          .describe("The reply, plain text. Do not quote the earlier messages."),
        reply_all: z
          .boolean()
          .optional()
          .describe("Also answer everyone on that message. Default false."),
        send_at: sendAt,
      }),
      execute: async ({ thread_id, text, reply_all, send_at }) =>
        sending(
          scope.reply(
            thread_id,
            { text, replyAll: reply_all, sendAt: send_at, draft: options.drafts },
            await once("reply", thread_id, send_at ?? null),
          ),
          "You already replied in this thread in this run.",
        ),
    }),

    defineTool({
      name: "cancel_scheduled",
      description:
        "Cancel an email you scheduled with send_at before it goes out, for example a follow-up the customer no longer needs. get_thread shows scheduled emails with their id.",
      input: z.object({
        email_id: z.string().describe("The scheduled email's id, eml_…"),
      }),
      execute: ({ email_id }) => scope.cancelScheduled(email_id),
    }),

    defineTool({
      name: "set_thread_status",
      description:
        "Record where a conversation stands, for example open, waiting or done, with an optional note for later. list_threads can filter on it.",
      input: z.object({
        thread_id: z.string().describe("The thread id, thr_…"),
        status: z.string().min(1).max(40),
        note: z
          .string()
          .max(2_000)
          .optional()
          .describe("Anything worth remembering about this thread."),
      }),
      execute: async ({ thread_id, status, note }) => {
        await scope.setStatus(thread_id, status, note)
        return { ok: true }
      },
    }),
  ]
}
