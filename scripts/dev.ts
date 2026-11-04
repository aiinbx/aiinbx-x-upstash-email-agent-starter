/**
 * Local server for trying the kit: the webhook, the workflow and an MCP
 * endpoint for one inbox. Run with `npm run dev`, then forward AI Inbx events
 * to it with `npx @aiinbx/cli listen --forward-to localhost:3000/webhook`.
 * Your agent goes in `onEmail` below. Or connect an MCP client to
 * localhost:3000/mcp and use the tools yourself.
 */
import { createEmailKit, createEmailTools } from "../src"
import { createMcpHandler } from "../src/adapters/mcp"
import { serve } from "./serve"

const port = Number(process.env.PORT ?? 3000)
const inbox = process.env.AGENT_INBOX ?? "agent@email-agent-starter.aiinbx.app"

const kit = createEmailKit({
  workflow:
    process.env.QSTASH_DEV || process.env.QSTASH_TOKEN
      ? {
          url: `http://localhost:${port}/workflow`,
          followUpSeconds: Number(process.env.FOLLOW_UP_SECONDS) || undefined,
        }
      : undefined,
  onEmail: async ({ email, tenant, inbox }) => {
    console.log(`[onEmail] ${tenant}/${inbox} ← ${email.from.address}: ${email.subject}`)
    // Hand `tools` (also in the arguments) to your agent here.
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
