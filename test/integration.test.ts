/**
 * The kit against real Upstash Redis, Vector and Blob, with AI Inbx faked.
 * Every run writes under its own prefix and removes it afterwards.
 */
import { webhookDeliveryHeaders } from "aiinbx/webhooks"
import { Bucket } from "@upstash/blob"
import { Redis } from "@upstash/redis"
import { Index } from "@upstash/vector"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createEmailKit, createEmailTools, NotInScopeError, type EmailKitOptions } from "../src"
import type { ChunkMetadata } from "../src/context"
import { allOf, senderLimit, skipCategories, skipOwnInboxes } from "../src/addons/filters"
import { handleEmail } from "../src/handle"
import type { StoredEmail } from "../src/types"
import { fakeAIInbx } from "./fake-aiinbx"

const AGENT = "agent@acme.test"
const OTHER = "sales@acme.test"
const SECRET = "whsec_test"
const prefix = `test-${Date.now().toString(36)}`
const redis = Redis.fromEnv()
const vector = Index.fromEnv() as Index<ChunkMetadata>
const bucket = Bucket.fromEnv()

const INVOICE_TEXT = [
  "# Invoice INV-2026-0042",
  "Acme Robotics GmbH bills Kestrel Labs for the November robot lease.",
  "Total due: 4,200.00 EUR, payable by 2026-12-01.",
  "",
  "Late payments accrue 1% interest per month. ".repeat(40),
].join("\n")

function setup(options: Partial<EmailKitOptions> = {}) {
  const fake = fakeAIInbx()
  const kit = createEmailKit({
    aiinbx: fake.client,
    redis,
    vector,
    bucket,
    prefix,
    webhookSecret: SECRET,
    ...options,
  })
  return { fake, kit }
}

function tool(kit: ReturnType<typeof setup>["kit"], inbox: string, name: string) {
  const found = createEmailTools(kit.scope({ inboxes: inbox, name: "Agent" })).find(
    (t) => t.name === name,
  )
  if (!found) throw new Error(`no tool ${name}`)
  return (input: Record<string, unknown>) => found.execute(input as never) as Promise<any>
}

/** Vector indexes asynchronously: poll until the query sees the write. */
async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 30; i++) {
    const value = await read()
    if (ok(value)) return value
    await new Promise((r) => setTimeout(r, 1_000))
  }
  throw new Error("condition not met in 30s")
}

const { fake, kit } = setup()

beforeAll(async () => {
  fake.add({
    id: "eml_invoice",
    thread_id: "thr_invoice",
    from: { name: "Anna Weber", address: "Anna@Vendor.example" },
    to: [AGENT],
    cc: ["finance@vendor.example"],
    subject: "Invoice for November",
    text: "Hi, attached is our invoice.\n\n> earlier quoted text",
    stripped_text: "Hi, attached is our invoice. When will you pay?",
    html: "<p>Hi, attached is our invoice.</p>",
    created_at: "2026-11-04T10:00:00.000Z",
  })
  fake.addAttachment("eml_invoice", {
    id: "att_invoice",
    filename: "invoice.pdf",
    content_type: "application/pdf; name=invoice.pdf",
    bytes: new TextEncoder().encode("%PDF-1.3 fake"),
    text: INVOICE_TEXT,
  })
  fake.addAttachment("eml_invoice", {
    id: "att_photo",
    filename: "photo.heic",
    content_type: "image/heic",
    bytes: new Uint8Array([1, 2, 3]),
    text: null,
  })
  fake.add({
    id: "eml_lunch",
    thread_id: "thr_lunch",
    from: { name: "Bob", address: "bob@friend.example" },
    to: [OTHER],
    subject: "Lunch on Friday?",
    stripped_text: "Want to grab lunch on Friday at the Italian place?",
    created_at: "2026-11-04T11:00:00.000Z",
  })
  fake.addAttachment("eml_lunch", {
    id: "att_menu",
    filename: "menu.pdf",
    content_type: "application/pdf",
    bytes: null,
    text: "Menu: pasta, pizza, tiramisu",
  })
  await kit.ingest("eml_invoice")
  await kit.ingest("eml_lunch")
})

afterAll(async () => {
  for (const p of [prefix, `${prefix}-backfill`]) {
    let cursor = "0"
    do {
      const [next, found] = await redis.scan(cursor, { match: `${p}:*`, count: 500 })
      if (found.length) await redis.del(...found)
      cursor = String(next)
    } while (cursor !== "0")
    await bucket.del({ prefix: `${p}/` })
    for (const ns of Object.keys((await vector.info()).namespaces)) {
      if (ns.startsWith(`${p}:`)) await vector.deleteNamespace(ns)
    }
  }
})

describe("ingest", () => {
  it("files mail under the inboxes it reached and keeps what the message says", async () => {
    const thread = await tool(kit, AGENT, "get_thread")({ thread_id: "thr_invoice" })
    expect(thread.messages).toHaveLength(1)
    const [message] = thread.messages
    expect(message.text).toBe("Hi, attached is our invoice. When will you pay?")
    expect(message.from.address).toBe("anna@vendor.example")
    expect(message.attachments.map((a: any) => [a.filename, a.has_text])).toEqual([
      ["invoice.pdf", true],
      ["photo.heic", false],
    ])
  })

  it("copies attachment bytes, text and the HTML body to Blob", async () => {
    const paths = (await bucket.list({ prefix: `${prefix}/default/` })).blobs
      .map((b) => b.path)
      .sort()
    expect(paths).toEqual([
      `${prefix}/default/attachments/att_invoice/content.md`,
      `${prefix}/default/attachments/att_invoice/invoice.pdf`,
      `${prefix}/default/attachments/att_menu/content.md`,
      `${prefix}/default/attachments/att_photo/photo.heic`,
      `${prefix}/default/emails/eml_invoice/body.html`,
    ])
  })

  it("changes nothing when the same email is ingested again", async () => {
    const count = async () => {
      const ns = (await vector.info()).namespaces[`${prefix}:default`]!
      return ns.pendingVectorCount === 0 ? ns.vectorCount : null
    }
    const before = await eventually(count, (n) => n !== null)
    await kit.ingest("eml_invoice")
    await kit.ingest("eml_invoice")
    expect(await redis.zcard(`${prefix}:default:inbox:${AGENT}:thread:thr_invoice`)).toBe(1)
    expect(await eventually(count, (n) => n !== null)).toBe(before)
  })
})

describe("inbox scope", () => {
  it("lists only the inbox's own threads", async () => {
    const agent = await tool(kit, AGENT, "list_threads")({})
    const other = await tool(kit, OTHER, "list_threads")({})
    expect(agent.map((t: any) => t.id)).toEqual(["thr_invoice"])
    expect(other.map((t: any) => t.id)).toEqual(["thr_lunch"])
    expect(agent[0]).toMatchObject({ subject: "Invoice for November", message_count: 1 })
  })

  it("refuses threads and attachments of another inbox", async () => {
    await expect(tool(kit, OTHER, "get_thread")({ thread_id: "thr_invoice" })).rejects.toThrow(
      NotInScopeError,
    )
    await expect(
      tool(kit, OTHER, "read_attachment")({ attachment_id: "att_invoice" }),
    ).rejects.toThrow(NotInScopeError)
    await expect(
      tool(kit, OTHER, "reply")({ thread_id: "thr_invoice", text: "hi" }),
    ).rejects.toThrow(NotInScopeError)
    expect(fake.calls.reply).toHaveLength(0)
  })

  it("never searches another inbox's mail", async () => {
    const hits = await eventually(
      () => tool(kit, OTHER, "search_emails")({ query: "invoice robot lease payment" }),
      (h: any[]) => h.length > 0,
    )
    expect(hits.every((h: any) => h.thread_id === "thr_lunch")).toBe(true)
  })
})

describe("search", () => {
  it("finds a fact that only appears inside an attachment", async () => {
    const hits = await eventually(
      () => tool(kit, AGENT, "search_emails")({ query: "how much is due and by when?" }),
      (h: any[]) => h.some((x) => x.source === "attachment"),
    )
    const hit = hits.find((h: any) => h.source === "attachment")
    expect(hit).toMatchObject({
      attachment_id: "att_invoice",
      filename: "invoice.pdf",
      thread_id: "thr_invoice",
    })
    expect(hit.excerpt).toContain("4,200.00 EUR")
  })

  it("filters by sender and time", async () => {
    const from = await tool(
      kit,
      AGENT,
      "search_emails",
    )({ query: "invoice", from: "ANNA@vendor.example" })
    expect(from.length).toBeGreaterThan(0)
    const none = await tool(
      kit,
      AGENT,
      "search_emails",
    )({ query: "invoice", after: "2026-11-05T00:00:00Z" })
    expect(none).toEqual([])
    await expect(
      tool(kit, AGENT, "search_emails")({ query: "x", from: "a'b@example.com" }),
    ).rejects.toThrow(/Unsupported character/)
  })
})

describe("search across languages", () => {
  // A German question against an English inbox: one Acme invoice PDF among a
  // dozen ordinary emails, one of them another vendor's invoice.
  const tenant = "spc_search"
  const others: [string, string, string][] = [
    [
      "Shipping update for order 1182",
      "logistics@parcel.example",
      "Your order 1182 left the warehouse and arrives Thursday.",
    ],
    [
      "Team offsite in Lisbon",
      "office@kestrel.example",
      "We booked the offsite for March 3 to 5. Flights are on the company card.",
    ],
    [
      "Your Figma receipt",
      "billing@figma.example",
      "Thanks for your payment of $45.00 for the Professional plan.",
    ],
    [
      "Re: Q4 hiring plan",
      "ceo@kestrel.example",
      "Let's open two backend roles and one designer role before December.",
    ],
    [
      "Initech invoice INV-77",
      "ar@initech.example",
      "Invoice INV-77 for consulting, total 980 USD, due January 15.",
    ],
    [
      "Server outage postmortem",
      "sre@kestrel.example",
      "The database ran out of connections at 02:14 UTC. Root cause and fixes attached.",
    ],
    ["Lunch on Friday?", "bob@friend.example", "Want to try the new ramen place on Friday?"],
    [
      "Contract renewal with Globex",
      "legal@globex.example",
      "The renewal terms are attached for your signature by next week.",
    ],
    [
      "Newsletter: what's new in November",
      "news@saas.example",
      "Dark mode, faster exports and a new API for webhooks.",
    ],
    [
      "Password reset requested",
      "noreply@tool.example",
      "Someone asked to reset your password. Ignore this if it was you.",
    ],
    ["Re: office keys", "office@kestrel.example", "Spare keys are with reception now."],
  ]

  beforeAll(async () => {
    const add = async (id: string, subject: string, from: string, text: string) => {
      fake.add({
        id,
        thread_id: `thr_${id}`,
        space_id: tenant,
        to: [AGENT],
        subject,
        from: { name: null, address: from },
        stripped_text: text,
      })
    }
    await add(
      "eml_acme",
      "Invoice for November",
      "anna@acme.example",
      "Hi, attached is our invoice for the November robot lease. Thanks, Anna",
    )
    fake.addAttachment("eml_acme", {
      id: "att_acme",
      filename: "invoice.pdf",
      content_type: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.3 fake"),
      text: INVOICE_TEXT,
    })
    for (const [i, [subject, from, text]] of others.entries())
      await add(`eml_other_${i}`, subject, from, text)
    for (const id of ["eml_acme", ...others.map((_, i) => `eml_other_${i}`)]) {
      await kit.ingest(id, { hints: { recipients: [AGENT] } })
    }
  })

  it("finds the English invoice from a German question", async () => {
    const scope = kit.scope({ tenant, inboxes: AGENT })
    const hits = await eventually(
      () => scope.search({ query: "Wie viel schulden wir Acme noch, und bis wann?" }),
      (h) => h.length >= 5,
    )
    expect(hits[0]).toMatchObject({ email_id: "eml_acme", source: "attachment" })
    expect(hits[0]!.excerpt).toContain("4,200.00 EUR")
  })
})

describe("attachments", () => {
  it("reads long text in parts", async () => {
    const read = tool(kit, AGENT, "read_attachment")
    const first = await read({ attachment_id: "att_invoice", max_chars: 500 })
    expect(first.text).toHaveLength(500)
    expect(first.total_chars).toBe(INVOICE_TEXT.length)
    const rest = await read({
      attachment_id: "att_invoice",
      offset: first.next_offset,
      max_chars: 50_000,
    })
    expect(first.text + rest.text).toBe(INVOICE_TEXT)
    expect(rest.next_offset).toBeNull()
  })

  it("keeps the text of a file AI Inbx no longer has the bytes of", async () => {
    const menu = await tool(kit, OTHER, "read_attachment")({ attachment_id: "att_menu" })
    expect(menu.text).toContain("tiramisu")
  })

  it("hands out a download link when a file has no text", async () => {
    const photo = await tool(kit, AGENT, "read_attachment")({ attachment_id: "att_photo" })
    expect(photo.text).toBeNull()
    const download = await fetch(photo.download_url)
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
  })
})

describe("sending", () => {
  it("replies as the inbox to the sender, and shows the reply in the thread right away", async () => {
    const sent = await tool(
      kit,
      AGENT,
      "reply",
    )({ thread_id: "thr_invoice", text: "We pay on December 1." })
    expect(fake.calls.reply[0]).toMatchObject({
      threadId: "thr_invoice",
      body: {
        from: { name: "Agent", address: AGENT },
        to: ["anna@vendor.example"],
        text: "We pay on December 1.",
      },
      options: {},
    })
    const thread = await tool(kit, AGENT, "get_thread")({ thread_id: "thr_invoice" })
    expect(thread.messages.map((m: any) => m.id)).toEqual(["eml_invoice", sent.id])
    expect(thread.messages[1]).toMatchObject({ direction: "outbound", status: "queued" })
  })

  it("replies once per thread within a run, however the model words it", async () => {
    const tools = createEmailTools(kit.scope({ inboxes: AGENT }), { idempotencyScope: "run_1" })
    const reply = tools.find((t) => t.name === "reply")!
    const first = (await reply.execute({
      thread_id: "thr_invoice",
      text: "We pay Dec 1.",
    } as never)) as any
    // The run is retried after a crash; the model phrases the same reply differently.
    await expect(
      reply.execute({ thread_id: "thr_invoice", text: "Payment goes out on December 1." } as never),
    ).rejects.toThrow("already replied")
    // The exact same call replays the first send instead of mailing again.
    const again = (await reply.execute({
      thread_id: "thr_invoice",
      text: "We pay Dec 1.",
    } as never)) as any
    expect(again.id).toBe(first.id)
  })

  it("saves drafts for a person to approve when asked", async () => {
    const tools = createEmailTools(kit.scope({ inboxes: AGENT }), { drafts: true })
    expect(tools.find((t) => t.name === "reply")!.description).toContain("draft")
    const sent = (await tools
      .find((t) => t.name === "send_email")!
      .execute({ to: ["x@example.com"], subject: "Hi", text: "Hello." } as never)) as any
    expect(sent.status).toBe("draft")
    expect(fake.calls.send.at(-1)).toMatchObject({ body: { draft: true } })
  })

  it("lets your app approve, edit or discard drafts, each customer only its own", async () => {
    const write = (inbox: string, text: string) =>
      createEmailTools(kit.scope({ inboxes: inbox }), { drafts: true })
        .find((t) => t.name === "send_email")!
        .execute({ to: ["client@example.com"], subject: "Offer", text } as never) as Promise<any>
    const a = await write(AGENT, "First offer.")
    const b = await write(AGENT, "Second offer.")
    const sales = await write(OTHER, "Sales offer.")

    const review = kit.scope({ inboxes: AGENT })
    const ids = async () => (await review.listDrafts()).map((d) => d.id)
    expect(await ids()).toEqual(expect.arrayContaining([b.id, a.id]))
    expect((await ids()).indexOf(b.id)).toBeLessThan((await ids()).indexOf(a.id))
    expect(await ids()).not.toContain(sales.id)
    await expect(kit.scope({ inboxes: OTHER }).sendDraft(a.id)).rejects.toThrow(NotInScopeError)

    await review.updateDraft(a.id, { text: "First offer, 5% off." })
    expect((await review.sendDraft(a.id)).status).toBe("scheduled")
    await review.discardDraft(b.id)
    expect(await ids()).not.toContain(a.id)
    expect(await ids()).not.toContain(b.id)
    await expect(review.sendDraft(b.id)).rejects.toThrow(NotInScopeError)

    const thread = await review.getThread(a.thread_id)
    expect(thread.messages[0]).toMatchObject({ status: "scheduled", text: "First offer, 5% off." })
  })

  it("schedules a follow-up next to a reply, and cancels it", async () => {
    const tools = createEmailTools(kit.scope({ inboxes: AGENT }), { idempotencyScope: "run_sched" })
    const run = (name: string, input: object) =>
      tools.find((t) => t.name === name)!.execute(input as never) as Promise<any>
    await run("reply", { thread_id: "thr_invoice", text: "Got it, thanks." })
    const later = await run("reply", {
      thread_id: "thr_invoice",
      text: "Any update on the payment?",
      send_at: "2026-11-20T09:00:00Z",
    })
    expect(later.status).toBe("scheduled")
    expect(fake.calls.reply.at(-1)).toMatchObject({
      body: { scheduled_at: "2026-11-20T09:00:00Z" },
    })

    const other = createEmailTools(kit.scope({ inboxes: OTHER })).find(
      (t) => t.name === "cancel_scheduled",
    )!
    await expect(other.execute({ email_id: later.id } as never)).rejects.toThrow(NotInScopeError)
    expect(await run("cancel_scheduled", { email_id: later.id })).toEqual({
      id: later.id,
      status: "canceled",
    })
    const thread = await kit.scope({ inboxes: AGENT }).getThread("thr_invoice")
    expect(thread.messages.find((m: any) => m.id === later.id)!.status).toBe("canceled")
  })

  it("answers Reply-To and copies everyone else on reply-all", async () => {
    fake.add({
      id: "eml_team",
      thread_id: "thr_team",
      from: { name: "Carol", address: "carol@client.example" },
      reply_to: ["support@client.example"],
      to: [AGENT, "dave@client.example"],
      cc: ["erin@client.example"],
      subject: "Kickoff",
    })
    await kit.ingest("eml_team", { hints: { recipients: [AGENT] } })
    await tool(
      kit,
      AGENT,
      "reply",
    )({ thread_id: "thr_team", text: "See you then.", reply_all: true })
    expect(fake.calls.reply.at(-1)).toMatchObject({
      body: {
        to: ["support@client.example"],
        cc: ["dave@client.example", "erin@client.example"],
      },
    })
  })

  it("starts new threads from the inbox", async () => {
    const sent = await tool(
      kit,
      AGENT,
      "send_email",
    )({
      to: ["new@vendor.example"],
      subject: "Hello",
      text: "First contact.",
    })
    const threads = await tool(kit, AGENT, "list_threads")({})
    expect(threads[0].id).toBe(sent.thread_id)
  })

  it("records delivery status from webhook events", async () => {
    const response = await kit.webhook(await signed("email.bounced", { email_id: "eml_out_1" }))
    expect(response.status).toBe(204)
    const thread = await tool(kit, AGENT, "get_thread")({ thread_id: "thr_invoice" })
    expect(thread.messages.find((m: any) => m.id === "eml_out_1").status).toBe("bounced")
  })
})

describe("thread status", () => {
  it("keeps a status and note that list_threads filters on", async () => {
    const set = tool(kit, AGENT, "set_thread_status")
    await set({ thread_id: "thr_invoice", status: "waiting", note: "Paid Dec 1" })
    const waiting = await tool(kit, AGENT, "list_threads")({ status: "waiting" })
    expect(waiting.map((t: any) => [t.id, t.note])).toEqual([["thr_invoice", "Paid Dec 1"]])
    await set({ thread_id: "thr_invoice", status: "done" })
    const [done] = await tool(kit, AGENT, "list_threads")({ status: "done" })
    expect(done.note).toBe("Paid Dec 1")
  })
})

describe("a thread through two of our inboxes", () => {
  it("shows each inbox only its own messages, and shares the thread's status like a team inbox", async () => {
    const carol = { name: "Carol", address: "carol@client.example" }
    fake.add({
      id: "eml_shared_1",
      thread_id: "thr_shared",
      from: carol,
      to: [AGENT],
      subject: "Deal",
      stripped_text: "For support.",
    })
    fake.add({
      id: "eml_shared_2",
      thread_id: "thr_shared",
      from: carol,
      to: [OTHER],
      subject: "Re: Deal",
      stripped_text: "Private for sales.",
    })
    for (const [id, to] of [
      ["eml_shared_1", AGENT],
      ["eml_shared_2", OTHER],
    ] as const) {
      await kit.webhook(
        await signed("email.received", {
          email_id: id,
          thread_id: "thr_shared",
          domain_id: "dom_1",
          to: [to],
        }),
      )
    }
    const agent = await tool(kit, AGENT, "get_thread")({ thread_id: "thr_shared" })
    const other = await tool(kit, OTHER, "get_thread")({ thread_id: "thr_shared" })
    expect(agent.messages.map((m: any) => m.text)).toEqual(["For support."])
    expect(other.messages.map((m: any) => m.text)).toEqual(["Private for sales."])

    await tool(
      kit,
      AGENT,
      "set_thread_status",
    )({ thread_id: "thr_shared", status: "done", note: "support note" })
    const seen = await tool(kit, OTHER, "get_thread")({ thread_id: "thr_shared" })
    expect([seen.status, seen.note]).toEqual(["done", "support note"])

    // One email handled by both inboxes' agents: each may answer once.
    for (const inbox of [AGENT, OTHER]) {
      const reply = createEmailTools(kit.scope({ inboxes: inbox }), {
        idempotencyScope: "eml_shared_2",
      }).find((t) => t.name === "reply")!
      await reply.execute({ thread_id: "thr_shared", text: `From ${inbox}.` } as never)
    }
  })
})

describe("handler", () => {
  it("runs once per email, even when deliveries race", async () => {
    const onEmail = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 300))
    })
    const { fake, kit } = setup({ onEmail })
    fake.add({ id: "eml_race", thread_id: "thr_race", to: [AGENT], subject: "Race" })
    const results = await Promise.all([1, 2, 3].map(() => kit.ingest("eml_race")))
    expect(onEmail).toHaveBeenCalledTimes(1)
    expect(results.map((r) => r.outcomes[AGENT]).sort()).toEqual([
      "handled",
      "in_progress",
      "in_progress",
    ])
    expect((await kit.ingest("eml_race")).outcomes[AGENT]).toBe("duplicate")
  })

  it("asks AI Inbx to deliver again while an earlier delivery is still being handled", async () => {
    let release!: () => void
    const onEmail = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
    const { fake, kit } = setup({ onEmail })
    fake.add({ id: "eml_slow", thread_id: "thr_slow", to: [AGENT] })
    const deliver = async () =>
      kit.webhook(
        await signed("email.received", {
          email_id: "eml_slow",
          thread_id: "thr_slow",
          domain_id: "dom_1",
          to: [AGENT],
        }),
      )
    const first = deliver()
    await vi.waitFor(() => expect(onEmail).toHaveBeenCalled())
    expect((await deliver()).status).toBe(503)
    release()
    expect((await first).status).toBe(204)
    expect((await deliver()).status).toBe(204)
    expect(onEmail).toHaveBeenCalledTimes(1)
  })

  it("answers a quick follow-up together with the email before it", async () => {
    const onEmail = vi.fn(async () => {})
    const { fake, kit } = setup({ onEmail })
    const customer = { name: null, address: "carol@client.example" }
    fake.add({
      id: "eml_order",
      thread_id: "thr_order",
      to: [AGENT],
      from: customer,
      created_at: "2026-11-04T12:00:00.000Z",
    })
    fake.add({
      id: "eml_fix",
      thread_id: "thr_order",
      to: [AGENT],
      from: customer,
      created_at: "2026-11-04T12:00:04.000Z",
    })
    for (const id of ["eml_order", "eml_fix"])
      await kit.ingest(id, { hints: { recipients: [AGENT] }, handle: false })
    const handle = (id: string) =>
      kit.ctx.redis.get<StoredEmail>(`${prefix}:default:email:${id}`).then((email) =>
        handleEmail(kit.ctx, email!, AGENT, {
          onEmail,
          owner: "run",
          answerLatestOnly: true,
          forInbox: () => ({ scope: kit.scope({ inboxes: AGENT }), tools: [] }),
        }),
      )
    expect(await handle("eml_order")).toBe("superseded")
    expect(await handle("eml_fix")).toBe("handled")
    expect(onEmail).toHaveBeenCalledTimes(1)
  })

  it("lets a failed handler run again", async () => {
    const onEmail = vi
      .fn()
      .mockRejectedValueOnce(new Error("model down"))
      .mockResolvedValue(undefined)
    const { fake, kit } = setup({ onEmail })
    fake.add({ id: "eml_retry", thread_id: "thr_retry", to: [AGENT], subject: "Retry" })
    await expect(kit.ingest("eml_retry")).rejects.toThrow("model down")
    expect((await kit.ingest("eml_retry")).outcomes[AGENT]).toBe("handled")
    expect(onEmail).toHaveBeenCalledTimes(2)
  })

  it("hands an email to each inbox it reached, with tools acting as that inbox", async () => {
    const inboxes: string[] = []
    const { fake, kit } = setup({
      onEmail: async ({ inbox, tools }) => {
        inboxes.push(inbox)
        const threads = (await tools
          .find((t) => t.name === "list_threads")!
          .execute({} as never)) as any[]
        expect(threads.some((t) => t.id === "thr_both")).toBe(true)
      },
    })
    fake.add({ id: "eml_both", thread_id: "thr_both", to: [AGENT, OTHER] })
    await kit.webhook(
      await signed("email.received", {
        email_id: "eml_both",
        thread_id: "thr_both",
        domain_id: "dom_1",
        to: [AGENT, OTHER],
      }),
    )
    expect(inboxes.sort()).toEqual([AGENT, OTHER])
  })

  it("hands every received email to onEmail unless filters say otherwise", async () => {
    const onEmail = vi.fn(async () => {})
    const { fake, kit } = setup({ onEmail })
    fake.add({ id: "eml_ooo", thread_id: "thr_ooo", to: [AGENT], category: "out_of_office" })
    expect((await kit.ingest("eml_ooo")).outcomes[AGENT]).toBe("handled")
  })
})

describe("addons", () => {
  it("skip machines and our own inboxes when asked", async () => {
    const onEmail = vi.fn(async () => {})
    const { fake, kit } = setup({
      onEmail,
      shouldHandle: allOf(skipCategories("out_of_office"), skipOwnInboxes),
    })
    fake.add({ id: "eml_ooo2", thread_id: "thr_ooo2", to: [AGENT], category: "out_of_office" })
    fake.add({
      id: "eml_receipt",
      thread_id: "thr_receipt",
      to: [AGENT],
      category: "transactional",
    })
    fake.add({
      id: "eml_colleague",
      thread_id: "thr_colleague",
      to: [AGENT],
      from: { name: null, address: OTHER },
    })
    expect((await kit.ingest("eml_ooo2")).outcomes[AGENT]).toBe("skipped")
    expect((await kit.ingest("eml_receipt")).outcomes[AGENT]).toBe("handled")
    expect((await kit.ingest("eml_colleague")).outcomes[AGENT]).toBe("skipped")
  })

  it("limit a flooding sender, counting each email once", async () => {
    const onEmail = vi.fn().mockRejectedValueOnce(new Error("flaky")).mockResolvedValue(undefined)
    const { fake, kit } = setup({
      onEmail,
      shouldHandle: senderLimit({ max: 2, windowSeconds: 60 }),
    })
    const bot = { name: null, address: "loop@bot.example" }
    for (let i = 0; i < 3; i++)
      fake.add({ id: `eml_flood_${i}`, thread_id: `thr_flood_${i}`, to: [AGENT], from: bot })
    await expect(kit.ingest("eml_flood_0")).rejects.toThrow("flaky")
    const outcomes = []
    for (let i = 0; i < 3; i++) outcomes.push((await kit.ingest(`eml_flood_${i}`)).outcomes[AGENT])
    expect(outcomes).toEqual(["handled", "handled", "skipped"])
  })
})

describe("webhook", () => {
  it("rejects a delivery that is not signed with the secret", async () => {
    const request = await signed(
      "email.received",
      { email_id: "eml_x", thread_id: "thr_x", to: [AGENT] },
      "wrong",
    )
    expect((await kit.webhook(request)).status).toBe(401)
  })

  it("files mail under its envelope recipients, and a later backfill keeps them", async () => {
    fake.add({ id: "eml_bcc", thread_id: "thr_bcc", to: ["list@vendor.example"], subject: "Bcc'd" })
    const request = await signed("email.received", {
      email_id: "eml_bcc",
      thread_id: "thr_bcc",
      domain_id: "dom_1",
      to: [AGENT],
    })
    expect((await kit.webhook(request)).status).toBe(204)
    expect((await tool(kit, AGENT, "get_thread")({ thread_id: "thr_bcc" })).subject).toBe("Bcc'd")
    await kit.ingest("eml_bcc")
    expect((await tool(kit, AGENT, "get_thread")({ thread_id: "thr_bcc" })).messages).toHaveLength(
      1,
    )
  })

  it("never acts as an address mail merely names", async () => {
    fake.add({ id: "eml_named", thread_id: "thr_named", to: [AGENT], cc: ["alice@acme.test"] })
    await kit.webhook(
      await signed("email.received", {
        email_id: "eml_named",
        thread_id: "thr_named",
        domain_id: "dom_1",
        to: [AGENT],
      }),
    )
    await expect(
      tool(kit, "alice@acme.test", "get_thread")({ thread_id: "thr_named" }),
    ).rejects.toThrow(NotInScopeError)
  })
})

describe("backfill", () => {
  it("stores without handling, and resumes where it stopped", async () => {
    const onEmail = vi.fn(async () => {})
    const { fake, kit } = setup({ onEmail, prefix: `${prefix}-backfill` })
    fake.add({
      id: "eml_old_1",
      thread_id: "thr_old",
      to: [AGENT],
      created_at: "2026-01-01T00:00:00.000Z",
    })
    fake.add({
      id: "eml_old_2",
      thread_id: "thr_old",
      to: [AGENT],
      created_at: "2026-01-01T00:00:00.000Z",
    })
    expect(await kit.backfill()).toMatchObject({ count: 2, cursor: "2026-01-01T00:00:00.000Z" })
    expect(onEmail).not.toHaveBeenCalled()
    fake.add({
      id: "eml_new",
      thread_id: "thr_new",
      to: [AGENT],
      created_at: "2026-01-02T00:00:00.000Z",
    })
    const next = await kit.backfill({ handle: true })
    expect(next.cursor).toBe("2026-01-02T00:00:00.000Z")
    expect(onEmail).toHaveBeenCalledWith(
      expect.objectContaining({ inbox: AGENT, email: expect.objectContaining({ id: "eml_new" }) }),
    )
  })

  it("refuses a prefix flow control keys cannot carry", () => {
    expect(() => setup({ prefix: "mail:prod" })).toThrow(/prefix/)
  })
})

describe("tenants", () => {
  // The same address in two customers' spaces: each sees only its own mail.
  const received = async (id: string, space: string, text: string) => {
    fake.add({
      id,
      thread_id: `thr_${id}`,
      space_id: space,
      to: [AGENT],
      subject: `For ${space}`,
      stripped_text: text,
    })
    await kit.webhook(
      await signed(
        "email.received",
        { email_id: id, thread_id: `thr_${id}`, domain_id: "dom_1", to: [AGENT] },
        SECRET,
        space,
      ),
    )
  }

  beforeAll(async () => {
    await received("eml_spc_a", "spc_a", "Acme wants the blue widgets.")
    await received("eml_spc_b", "spc_b", "Globex wants the red widgets.")
  })

  it("keeps each tenant's threads, search and files apart", async () => {
    const a = kit.scope({ tenant: "spc_a", inboxes: AGENT })
    const b = kit.scope({ tenant: "spc_b", inboxes: AGENT })
    expect((await a.listThreads()).map((t) => t.id)).toEqual(["thr_eml_spc_a"])
    expect((await b.listThreads()).map((t) => t.id)).toEqual(["thr_eml_spc_b"])
    await expect(a.getThread("thr_eml_spc_b")).rejects.toThrow(NotInScopeError)
    const hits = await eventually(
      () => a.search({ query: "which widgets?" }),
      (h) => h.length > 0,
    )
    expect(hits.map((h) => h.email_id)).toEqual(["eml_spc_a"])
    // Mail outside any space stays in the default tenant.
    expect(
      (await kit.scope({ inboxes: AGENT }).listThreads()).some((t) => t.id === "thr_eml_spc_a"),
    ).toBe(false)
  })

  it("deletes one tenant and nothing else", async () => {
    await kit.deleteTenant("spc_b")
    expect(await kit.scope({ tenant: "spc_b", inboxes: "all" }).listThreads()).toEqual([])
    expect(await redis.keys(`${prefix}:spc_b:*`)).toEqual([])
    expect((await vector.info()).namespaces[`${prefix}:spc_b`]).toBeUndefined()
    expect(await kit.scope({ tenant: "spc_a", inboxes: AGENT }).listThreads()).toHaveLength(1)
  })

  it("hands the handler its tenant", async () => {
    const seen: string[] = []
    const { fake, kit } = setup({
      onEmail: async ({ tenant, scope }) => void seen.push(`${tenant}:${scope.tenant}`),
    })
    fake.add({ id: "eml_spc_c", thread_id: "thr_spc_c", space_id: "spc_c", to: [AGENT] })
    await kit.webhook(
      await signed(
        "email.received",
        { email_id: "eml_spc_c", thread_id: "thr_spc_c", domain_id: "dom_1", to: [AGENT] },
        SECRET,
        "spc_c",
      ),
    )
    expect(seen).toEqual(["spc_c:spc_c"])
  })
})

describe("scopes", () => {
  it("reads several inboxes, or all of a tenant's, as one", async () => {
    const team = await kit.scope({ inboxes: [AGENT, OTHER] }).listThreads({ limit: 50 })
    const all = await kit.scope({ inboxes: "all" }).listThreads({ limit: 50 })
    expect(team.map((t) => t.id)).toEqual(expect.arrayContaining(["thr_invoice", "thr_lunch"]))
    expect(all.map((t) => t.id).sort()).toEqual(team.map((t) => t.id).sort())
  })

  it("sends only from its own inboxes", async () => {
    const team = kit.scope({ inboxes: [AGENT, OTHER] })
    const mail = { to: ["x@example.com"], subject: "Hi", text: "Hello." }
    await expect(team.send(mail)).rejects.toThrow(/which inbox/)
    await expect(team.send({ ...mail, from: "ceo@acme.test" })).rejects.toThrow(NotInScopeError)
    await expect(
      kit.scope({ inboxes: "all" }).send({ ...mail, from: "ceo@acme.test" }),
    ).rejects.toThrow(NotInScopeError)
    expect((await team.send({ ...mail, from: OTHER })).id).toBeTruthy()
  })
})

async function signed(
  type: string,
  data: Record<string, unknown>,
  secret = SECRET,
  spaceId: string | null = null,
) {
  const body = JSON.stringify({
    id: `evt_${Math.random()}`,
    type,
    created_at: new Date().toISOString(),
    space_id: spaceId,
    data,
  })
  return new Request("http://localhost/webhook", {
    method: "POST",
    headers: await webhookDeliveryHeaders("evt_1", body, secret),
    body,
  })
}
