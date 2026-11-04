import { tool } from "@openai/agents"
import type { EmailTool } from "../tools"

/** OpenAI Agents SDK: `new Agent({ tools: toOpenAIAgentsTools(tools) })`. */
export function toOpenAIAgentsTools(tools: EmailTool[]) {
  return tools.map((t) =>
    tool({
      name: t.name,
      description: t.description,
      parameters: t.input,
      execute: (input) => t.execute(input),
      // The default hides every error from the model; ours say what to fix.
      errorFunction: (_ctx, error) => (error instanceof Error ? error.message : String(error)),
    }),
  )
}
