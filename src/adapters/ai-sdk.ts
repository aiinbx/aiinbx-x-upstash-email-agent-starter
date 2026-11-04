import { tool, type ToolSet } from "ai"
import type { EmailTool } from "../tools"

/** Vercel AI SDK: `generateText({ tools: toAiSdkTools(tools) })`. */
export function toAiSdkTools(tools: EmailTool[]): ToolSet {
  return Object.fromEntries(
    tools.map((t) => [
      t.name,
      tool({
        description: t.description,
        inputSchema: t.input,
        execute: (input) => t.execute(input),
      }),
    ]),
  )
}
