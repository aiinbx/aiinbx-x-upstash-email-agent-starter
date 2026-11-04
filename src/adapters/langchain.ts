import { tool } from "@langchain/core/tools"
import type { EmailTool } from "../tools"

/** LangChain / LangGraph: `createReactAgent({ tools: toLangChainTools(tools) })`. */
export function toLangChainTools(tools: EmailTool[]) {
  return tools.map((t) =>
    tool(async (input) => JSON.stringify(await t.execute(input)), {
      name: t.name,
      description: t.description,
      schema: t.input,
    }),
  )
}
