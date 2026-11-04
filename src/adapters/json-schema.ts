import { z } from "zod"
import type { EmailTool } from "../tools"

/**
 * Plain JSON Schema definitions, for calling a model API directly (OpenAI,
 * Anthropic, Gemini) or a framework without an adapter here. Run a call with
 * `runTool`.
 */
export function toJsonSchemaTools(tools: EmailTool[]) {
  return tools.map((t) => {
    const { $schema: _, ...parameters } = z.toJSONSchema(t.input, { io: "input" })
    return { name: t.name, description: t.description, parameters }
  })
}

/** Validate a model's tool call and run it. `args` may be the raw JSON string. */
export async function runTool(tools: EmailTool[], name: string, args: unknown): Promise<unknown> {
  const t = tools.find((candidate) => candidate.name === name)
  if (!t) throw new Error(`Unknown tool: ${name}`)
  const input = typeof args === "string" ? JSON.parse(args) : args
  return t.execute(t.input.parse(input))
}
