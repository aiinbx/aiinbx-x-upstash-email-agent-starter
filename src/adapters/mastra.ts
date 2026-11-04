import { createTool } from "@mastra/core/tools"
import type { EmailTool } from "../tools"

/** Mastra: `new Agent({ tools: toMastraTools(tools) })`. */
export function toMastraTools(tools: EmailTool[]) {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      createTool({
        id: t.name,
        description: t.description,
        inputSchema: t.input,
        execute: (input) => t.execute(input),
      }),
    ]),
  )
}
