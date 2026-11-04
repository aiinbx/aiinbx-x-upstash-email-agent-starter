import { toolDefinition } from "@tanstack/ai"
import type { EmailTool } from "../tools"

/** TanStack AI: `chat({ tools: toTanStackAiTools(tools) })`. */
export function toTanStackAiTools(tools: EmailTool[]) {
  return tools.map((t) =>
    toolDefinition({ name: t.name, description: t.description, inputSchema: t.input }).server(
      (input) => t.execute(input),
    ),
  )
}
