import type { AgentTool } from "@earendil-works/pi-agent-core"
import { z } from "zod"
import type { EmailTool } from "../tools"

/** Pi: `new Agent({ initialState: { model, tools: toPiTools(tools) } })`. */
export function toPiTools(tools: EmailTool[]): AgentTool[] {
  return tools.map((t) => {
    // Pi validates plain JSON Schema; `io: "input"` keeps optional fields optional.
    const { $schema: _, ...parameters } = z.toJSONSchema(t.input, { io: "input" })
    return {
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: parameters as AgentTool["parameters"],
      async execute(_toolCallId, params) {
        const result = await t.execute(t.input.parse(params))
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }
      },
    }
  })
}
