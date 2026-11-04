/**
 * The whole loop on real mail: a second AI Inbx workspace sends the agent an
 * invoice, the agent finds it, reads it, replies, and the sender answers in
 * the same thread. Needs `npm run dev` and `aiinbx listen` running, and
 * `E2E_SENDER_API_KEY` / `E2E_SENDER_FROM` for a workspace other than the
 * agent's (mail a workspace sends itself never arrives as received mail).
 */
import { readFileSync } from "node:fs"
import AIInbx from "aiinbx"
import { createEmailKit, createEmailTools } from "../src"

const inbox = required("AGENT_INBOX")
const sender = new AIInbx({ apiKey: required("E2E_SENDER_API_KEY") })
const senderFrom = required("E2E_SENDER_FROM")
const run = Date.now().toString(36)
const kit = createEmailKit()
const tools = Object.fromEntries(
  createEmailTools(kit.scope({ inboxes: inbox })).map((t) => [t.name, t]),
)
const call = (name: string, input: Record<string, unknown>) =>
  tools[name]!.execute(input as never) as Promise<any>

const started = Date.now()
const step = (label: string) =>
  console.log(`✓ ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`)

const sent = await sender.emails.send({
  from: senderFrom,
  to: inbox,
  subject: `Invoice for November [${run}]`,
  text: `Hi, attached is our invoice for the November robot lease. Please confirm and tell me the payment date. Run ${run}.`,
  attachments: [
    {
      filename: "invoice.pdf",
      content_type: "application/pdf",
      content: readFileSync(new URL("../test/fixtures/invoice.pdf", import.meta.url)).toString(
        "base64",
      ),
    },
  ],
})
step(`sent ${sent.id} from the sender workspace`)

const thread = await until("the email to be stored", async () => {
  const threads = await call("list_threads", { limit: 10 })
  return threads.find((t: any) => t.subject.includes(run))
})
step(`stored as ${thread.id}`)

const hit = await until("the attachment to be searchable", async () => {
  const hits = await call("search_emails", { query: "total amount due", thread_id: thread.id })
  return hits.find((h: any) => h.source === "attachment" && h.excerpt.includes("4,200.00 EUR"))
})
const text = await call("read_attachment", { attachment_id: hit.attachment_id })
assert(text.text.includes("INV-2026-0042"), "attachment text")
step("found the total inside the PDF and read the attachment")

const reply = await call("reply", {
  thread_id: thread.id,
  text: `Hi Anna, received INV-2026-0042 (4,200.00 EUR). We pay by December 1. [${run}]`,
})
step(`replied ${reply.id}`)

const received = await until("the reply to reach the sender", async () => {
  const page = await sender.emails.list({ direction: "inbound", limit: 20 })
  return page.data.find((e) => e.subject.includes(run))
})
assert(received.thread_id === sent.thread_id, "the reply joins the sender's thread")
step("the sender got the reply in its own thread")

await sender.threads.reply(received.thread_id, {
  text: `Perfect, thanks! Could you send your VAT ID too? [${run}]`,
})
const conversation = await until("the answer to be stored", async () => {
  const t = await call("get_thread", { thread_id: thread.id })
  return t.messages.length === 3 && t.messages[1].status === "delivered" ? t : null
})
assert(
  conversation.messages.map((m: any) => m.direction).join() === "inbound,outbound,inbound",
  "message order",
)
assert(!conversation.messages[2].text.includes("received INV-2026-0042"), "quoted text removed")
step("the sender's answer is in the same thread, quote removed, reply delivered")

console.log(`\nall good in ${((Date.now() - started) / 1000).toFixed(1)}s`)

async function until<T>(what: string, check: () => Promise<T | null | undefined>, seconds = 180) {
  for (const deadline = Date.now() + seconds * 1000; Date.now() < deadline;) {
    const value = await check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 2_000))
  }
  throw new Error(`gave up waiting for ${what}`)
}

function assert(ok: boolean, what: string): asserts ok {
  if (!ok) throw new Error(`failed: ${what}`)
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}`)
  return value
}
