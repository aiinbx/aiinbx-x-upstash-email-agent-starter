import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { EmailTool } from "../tools"

/**
 * An MCP server with the tools: for Claude Agent SDK, Cursor, or any MCP
 * client. Connect it to stdio for local use, or serve it with `createMcpHandler`.
 */
export function createMcpServer(tools: EmailTool[]) {
  const server = new McpServer({ name: "email", version: "1.0.0" })
  for (const t of tools) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.input },
      async (input: unknown) => ({
        content: [{ type: "text" as const, text: JSON.stringify(await t.execute(input as never)) }],
      }),
    )
  }
  return server
}

/**
 * Stateless Streamable HTTP: `Request` in, `Response` out, any runtime. Put
 * your own auth in front of it: whoever reaches it acts as the inbox.
 */
export function createMcpHandler(tools: () => EmailTool[] | Promise<EmailTool[]>) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null },
        { status: 405, headers: { Allow: "POST" } },
      )
    }
    // A stateless transport serves one request; so does its server.
    const server = createMcpServer(await tools())
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    try {
      return await transport.handleRequest(request)
    } finally {
      await server.close()
    }
  }
}
