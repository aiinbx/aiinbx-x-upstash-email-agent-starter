/**
 * Local server for trying the kit: the webhook, the workflow and an MCP
 * endpoint for one inbox. Run with `npm run dev`, then forward AI Inbx events
 * to it with `npx @aiinbx/cli listen --forward-to localhost:3000/webhook`.
 * Your agent goes in `onEmail` below; `examples/ai-sdk-agent.ts` shows one.
 */
import { createEmailKit, createEmailTools } from "../src"
import { createMcpHandler } from "../src/adapters/mcp"
import { draftingAgent } from "../examples/ai-sdk-agent"
import { serve } from "./serve"

const port = Number(process.env.PORT ?? 3000)
const inbox = process.env.AGENT_INBOX ?? "agent@email-agent-starter.aiinbx.app"

const agent = process.env.ANTHROPIC_API_KEY ? draftingAgent : null

const kit = createEmailKit({
  workflow:
    process.env.QSTASH_DEV || process.env.QSTASH_TOKEN
      ? { url: `http://localhost:${port}/workflow` }
      : undefined,
  // With a model key, the example agent writes drafts; without one, mail is only logged.
  ...(agent && { drafts: agent.drafts, shouldHandle: agent.shouldHandle }),
  onEmail: async (args) => {
    console.log(
      `[onEmail] ${args.tenant}/${args.inbox} ← ${args.email.from.address}: ${args.email.subject}`,
    )
    await agent?.onEmail(args)
  },
})
const mcp = createMcpHandler(() => createEmailTools(kit.scope({ inboxes: inbox })))

serve(port, (request) => {
  const { pathname } = new URL(request.url)
  if (pathname === "/webhook") return kit.webhook(request)
  if (pathname === "/workflow") return kit.workflow(request)
  if (pathname === "/mcp") return mcp(request)
  return new Response("Not found", { status: 404 })
})
console.log(`listening on http://localhost:${port} (inbox ${inbox})`)
