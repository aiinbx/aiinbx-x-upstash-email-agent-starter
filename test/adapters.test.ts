import { generateText, isStepCount } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { chat } from "@tanstack/ai"
import { fakeText } from "@tanstack/ai/testing"
import { Agent as MastraAgent } from "@mastra/core/agent"
import { MastraLanguageModelV2Mock } from "@mastra/core/test-utils/llm-mock"
import { Agent as PiAgent } from "@earendil-works/pi-agent-core"
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"
import { Agent as OpenAIAgent, run, Usage, type Model, type ModelResponse } from "@openai/agents"
import { AIMessageChunk, HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { FakeStreamingChatModel } from "@langchain/core/utils/testing"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { beforeEach, describe, expect, test } from "vitest"
import { z } from "zod"
import { createEmailKit } from "../src/kit"
import { createEmailTools, type EmailTool } from "../src/tools"
import { toAiSdkTools } from "../src/adapters/ai-sdk"
import { toTanStackAiTools } from "../src/adapters/tanstack-ai"
import { toMastraTools } from "../src/adapters/mastra"
import { toPiTools } from "../src/adapters/pi"
import { toOpenAIAgentsTools } from "../src/adapters/openai-agents"
import { toLangChainTools } from "../src/adapters/langchain"
import { createMcpHandler, createMcpServer } from "../src/adapters/mcp"
import { runTool, toJsonSchemaTools } from "../src/adapters/json-schema"

/** Dummy tool: `b` is optional, so every framework must cope with an omitted field. */
const calls: unknown[] = []
const addInput = z.object({ a: z.number(), b: z.number().optional() })
const add: EmailTool = {
  name: "add",
  description: "Add two numbers",
  input: addInput,
  async execute(input) {
    const { a, b } = input as z.infer<typeof addInput>
    calls.push({ a, b })
    return { sum: a + (b ?? 0) }
  },
}
beforeEach(() => {
  calls.length = 0
})

/** The 7 real tools, on stub clients: construction touches no network. */
const kit = createEmailKit({
  aiinbx: {} as never,
  redis: {} as never,
  vector: { namespace: () => ({}) } as never,
  bucket: {} as never,
  webhookSecret: "x",
})
const real = createEmailTools(kit.scope({ inboxes: "agent@example.com" }))
const realNames = real.map((t) => t.name)

test("createEmailTools returns the 7 tools", () => {
  expect(realNames).toEqual([
    "list_threads",
    "get_thread",
    "search_emails",
    "read_attachment",
    "send_email",
    "reply",
    "set_thread_status",
  ])
})

describe("AI SDK", () => {
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  }
  const step = (content: object[], unified: "tool-calls" | "stop") => ({
    content,
    finishReason: { unified, raw: undefined },
    usage,
    warnings: [],
  })
  const callAdd = (id: string, input: object) => ({
    type: "tool-call",
    toolCallId: id,
    toolName: "add",
    input: JSON.stringify(input),
  })

  test("runs through generateText, rejects invalid input", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        step(
          [callAdd("c1", { a: 2, b: 3 }), callAdd("c2", { a: 5 }), callAdd("c3", { a: "x" })],
          "tool-calls",
        ),
        step([{ type: "text", text: "done" }], "stop"),
      ] as never,
    })
    const result = await generateText({
      model,
      tools: toAiSdkTools([add]),
      stopWhen: isStepCount(2),
      prompt: "add",
    })
    expect(result.text).toBe("done")
    expect(result.steps[0]!.toolResults.map((r) => r.output)).toEqual([{ sum: 5 }, { sum: 5 }])
    expect(result.steps[0]!.content.some((c) => c.type === "tool-error")).toBe(true)
    expect(calls).toEqual([
      { a: 2, b: 3 },
      { a: 5, b: undefined },
    ])
  })

  test("converts the real tools", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: step([{ type: "text", text: "ok" }], "stop") as never,
    })
    await generateText({ model, tools: toAiSdkTools(real), prompt: "x" })
    const sent = model.doGenerateCalls[0]!.tools!
    expect(sent.map((t) => t.name)).toEqual(realNames)
    expect(sent.map((t) => (t as { description?: string }).description)).toEqual(
      real.map((t) => t.description),
    )
  })
})

describe("TanStack AI", () => {
  test("runs through chat(), rejects invalid input", async () => {
    const adapter = fakeText()
    adapter.setResponses([
      {
        toolCalls: [
          { name: "add", input: { a: 2, b: 3 } },
          { name: "add", input: { a: 5 } },
        ],
      },
      { toolCalls: [{ name: "add", input: { a: "x" } }] },
      { text: "done" },
    ])
    const { text, chunks } = await chat({
      adapter,
      messages: [{ role: "user", content: "add" }],
      tools: toTanStackAiTools([add]),
      threadId: "t",
      stream: false,
    })
    expect(text).toBe("done")
    expect(calls).toEqual([
      { a: 2, b: 3 },
      { a: 5, b: undefined },
    ])
    const results = chunks
      .filter((c) => c.type === "TOOL_CALL_RESULT")
      .map((c) => JSON.stringify(c))
    expect(results.filter((r) => r.includes('\\"sum\\":5'))).toHaveLength(2)
  })

  test("converts the real tools", async () => {
    const adapter = fakeText()
    let sent: { name: string; description: string }[] = []
    adapter.setResponses([
      ({ request }) => {
        sent = request.tools as never
        return { text: "ok" }
      },
    ])
    await chat({
      adapter,
      messages: [{ role: "user", content: "x" }],
      tools: toTanStackAiTools(real),
      threadId: "t",
      stream: false,
    })
    expect(sent.map((t) => t.name)).toEqual(realNames)
    expect(sent.map((t) => t.description)).toEqual(real.map((t) => t.description))
  })
})

describe("Mastra", () => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
  const callAdd = (id: string, input: object) => ({
    type: "tool-call" as const,
    toolCallId: id,
    toolName: "add",
    input: JSON.stringify(input),
  })

  test("runs through Agent.generate, rejects invalid input", async () => {
    let n = 0
    const model = new MastraLanguageModelV2Mock({
      doGenerate: async () =>
        n++ === 0
          ? {
              content: [
                callAdd("c1", { a: 2, b: 3 }),
                callAdd("c2", { a: 5 }),
                callAdd("c3", { a: "x" }),
              ],
              finishReason: "tool-calls",
              usage,
              warnings: [],
            }
          : {
              content: [{ type: "text", text: "done" }],
              finishReason: "stop",
              usage,
              warnings: [],
            },
    })
    const agent = new MastraAgent({
      id: "t",
      name: "t",
      instructions: "x",
      model,
      tools: toMastraTools([add]),
    })
    const res = await agent.generate("add", { maxSteps: 3 })
    expect(res.text).toBe("done")
    const results = res.toolResults.map((r: any) => r.payload ?? r)
    const byId = (id: string) => results.find((r: any) => r.toolCallId === id)?.result
    expect(byId("c1")).toEqual({ sum: 5 })
    expect(byId("c2")).toEqual({ sum: 5 })
    expect(byId("c3")).toMatchObject({ error: true })
    expect(calls).toEqual([
      { a: 2, b: 3 },
      { a: 5, b: undefined },
    ])
  })

  test("converts the real tools", async () => {
    const model = new MastraLanguageModelV2Mock({
      doGenerate: async () => ({
        content: [{ type: "text", text: "ok" }],
        finishReason: "stop",
        usage,
        warnings: [],
      }),
    })
    const tools = toMastraTools(real)
    const agent = new MastraAgent({ id: "t", name: "t", instructions: "x", model, tools })
    await agent.generate("x")
    const sent = model.doGenerateCalls[0]!.tools as { name: string; description?: string }[]
    expect(sent.map((t) => t.name)).toEqual(realNames)
    expect(sent.map((t) => t.description)).toEqual(real.map((t) => t.description))
  })
})

describe("Pi", () => {
  test("runs through the Agent loop, rejects invalid input", async () => {
    const faux = createFauxCore({})
    {
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("add", { a: 2, b: 3 }, { id: "c1" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxToolCall("add", { a: 5 }, { id: "c2" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxToolCall("add", { a: "x" }, { id: "c3" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxText("done")]),
      ])
      const agent = new PiAgent({
        streamFn: faux.streamSimple,
        initialState: { model: faux.getModel(), tools: toPiTools([add]) },
      })
      await agent.prompt("add")
      const results = agent.state.messages.flatMap((m) => (m.role === "toolResult" ? [m] : []))
      expect(
        results.map((r) => [r.isError, r.content[0]?.type === "text" && r.content[0].text]),
      ).toEqual([
        [false, '{"sum":5}'],
        [false, '{"sum":5}'],
        [true, expect.stringContaining("Validation failed")],
      ])
      expect(calls).toEqual([
        { a: 2, b: 3 },
        { a: 5, b: undefined },
      ])
    }
  })

  test("converts the real tools", () => {
    const tools = toPiTools(real)
    expect(tools.map((t) => t.name)).toEqual(realNames)
    expect(tools.map((t) => t.description)).toEqual(real.map((t) => t.description))
    for (const t of tools)
      expect(t.parameters).toMatchObject({ type: "object", properties: expect.any(Object) })
  })
})

describe("OpenAI Agents", () => {
  /** A model that returns the scripted outputs in turn and records the tools it was offered. */
  function scriptedModel(outputs: ModelResponse["output"][]) {
    const requests: Parameters<Model["getResponse"]>[0][] = []
    const model: Model = {
      async getResponse(request) {
        requests.push(request)
        return { usage: new Usage(), output: outputs[requests.length - 1] ?? [] }
      },
      getStreamedResponse() {
        throw new Error("not used")
      },
    }
    return { model, requests }
  }
  const callAdd = (callId: string, args: object) => ({
    type: "function_call" as const,
    callId,
    name: "add",
    arguments: JSON.stringify(args),
    status: "completed" as const,
  })
  const say = (text: string) => ({
    type: "message" as const,
    role: "assistant" as const,
    status: "completed" as const,
    content: [{ type: "output_text" as const, text }],
  })

  test("runs through run(), rejects invalid input", async () => {
    // Strict mode: the model sends every key, `null` where a field is absent.
    const { model } = scriptedModel([
      [
        callAdd("c1", { a: 2, b: 3 }),
        callAdd("c2", { a: 5, b: null }),
        callAdd("c3", { a: "x", b: null }),
      ],
      [say("done")],
    ])
    const agent = new OpenAIAgent({ name: "t", model, tools: toOpenAIAgentsTools([add]) })
    const result = await run(agent, "add")
    expect(result.finalOutput).toBe("done")
    const outputs = Object.fromEntries(
      result.newItems.flatMap((i) =>
        i.type === "tool_call_output_item"
          ? [[(i.rawItem as { callId: string }).callId, i.output]]
          : [],
      ),
    )
    expect(outputs.c1).toEqual({ sum: 5 })
    expect(outputs.c2).toEqual({ sum: 5 })
    expect(String(outputs.c3)).toMatch(/invalid/i)
    expect(calls).toEqual([
      { a: 2, b: 3 },
      { a: 5, b: undefined },
    ])
  })

  test("converts the real tools (strict schemas)", async () => {
    const { model, requests } = scriptedModel([[say("ok")]])
    const tools = toOpenAIAgentsTools(real)
    await run(new OpenAIAgent({ name: "t", model, tools }), "x")
    const sent = requests[0]!.tools as { name: string; description: string; strict: boolean }[]
    expect(sent.map((t) => t.name)).toEqual(realNames)
    expect(sent.map((t) => t.description)).toEqual(real.map((t) => t.description))
    expect(sent.every((t) => t.strict)).toBe(true)
  })
})

describe("LangChain", () => {
  /** One agent turn: the model answers with tool calls, each runs as a ToolMessage. */
  async function turn(
    tools: ReturnType<typeof toLangChainTools>,
    toolCalls: { id: string; args: object }[],
  ) {
    const model = new FakeStreamingChatModel({
      chunks: [
        new AIMessageChunk({
          content: "",
          tool_calls: toolCalls.map((c) => ({ ...c, name: "add" })),
        }),
      ],
    }).bindTools(tools)
    const ai = await model.invoke([new HumanMessage("add")])
    const messages: BaseMessage[] = []
    for (const call of ai.tool_calls ?? []) {
      messages.push(
        await tools.find((t) => t.name === call.name)!.invoke({ ...call, type: "tool_call" }),
      )
    }
    return messages
  }

  test("runs model tool calls through the tools, rejects invalid input", async () => {
    const tools = toLangChainTools([add])
    const [m1, m2] = await turn(tools, [
      { id: "c1", args: { a: 2, b: 3 } },
      { id: "c2", args: { a: 5 } },
    ])
    expect([m1!.content, m2!.content]).toEqual(['{"sum":5}', '{"sum":5}'])
    await expect(turn(tools, [{ id: "c3", args: { a: "x" } }])).rejects.toThrow()
    expect(calls).toEqual([
      { a: 2, b: 3 },
      { a: 5, b: undefined },
    ])
  })

  test("converts the real tools", () => {
    const tools = toLangChainTools(real)
    new FakeStreamingChatModel({ toolStyle: "openai" }).bindTools(tools)
    expect(tools.map((t) => t.name)).toEqual(realNames)
    expect(tools.map((t) => t.description)).toEqual(real.map((t) => t.description))
  })
})

describe("MCP", () => {
  async function connected(transport: Parameters<Client["connect"]>[0]) {
    const client = new Client({ name: "test", version: "0" })
    await client.connect(transport)
    return client
  }
  async function inMemory(tools: EmailTool[]) {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await createMcpServer(tools).connect(serverSide)
    return connected(clientSide)
  }
  /** The web handler, called in process: the client's fetch is the handler itself. */
  function overHttp(tools: EmailTool[]) {
    const handler = createMcpHandler(() => tools)
    return connected(
      new StreamableHTTPClientTransport(new URL("http://mcp.test/"), {
        fetch: (url, init) => handler(new Request(url, init)),
      }),
    )
  }

  for (const [label, connect] of [
    ["in-memory", inMemory],
    ["createMcpHandler", overHttp],
  ] as const) {
    test(`${label}: calls the tool, rejects invalid input`, async () => {
      const client = await connect([add])
      const text = async (args: Record<string, unknown>) =>
        (await client.callTool({ name: "add", arguments: args })).content
      expect(await text({ a: 2, b: 3 })).toEqual([{ type: "text", text: '{"sum":5}' }])
      expect(await text({ a: 5 })).toEqual([{ type: "text", text: '{"sum":5}' }])
      expect((await client.callTool({ name: "add", arguments: { a: "x" } })).isError).toBe(true)
      expect(calls).toEqual([
        { a: 2, b: 3 },
        { a: 5, b: undefined },
      ])
      await client.close()
    })

    test(`${label}: lists the real tools`, async () => {
      const client = await connect(real)
      const { tools } = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(realNames)
      expect(tools.map((t) => t.description)).toEqual(real.map((t) => t.description))
      for (const t of tools)
        expect(t.inputSchema).toMatchObject({ type: "object", properties: expect.any(Object) })
      await client.close()
    })
  }

  test("createMcpHandler refuses GET", async () => {
    const res = await createMcpHandler(() => [add])(new Request("http://mcp.test/"))
    expect(res.status).toBe(405)
  })
})

describe("JSON Schema", () => {
  test("runTool validates and runs, raw JSON or object", async () => {
    expect(await runTool([add], "add", '{"a":2,"b":3}')).toEqual({ sum: 5 })
    expect(await runTool([add], "add", { a: 5 })).toEqual({ sum: 5 })
    await expect(runTool([add], "add", { a: "x" })).rejects.toThrow()
    await expect(runTool([add], "nope", {})).rejects.toThrow("Unknown tool: nope")
    expect(calls).toEqual([
      { a: 2, b: 3 },
      { a: 5, b: undefined },
    ])
  })

  test("converts the real tools", () => {
    const tools = toJsonSchemaTools(real)
    expect(tools.map((t) => t.name)).toEqual(realNames)
    expect(tools.map((t) => t.description)).toEqual(real.map((t) => t.description))
    for (const t of tools) {
      expect(t.parameters).toMatchObject({ type: "object", properties: expect.any(Object) })
      expect(t.parameters).not.toHaveProperty("$schema")
    }
    expect(tools.find((t) => t.name === "get_thread")!.parameters.required).toEqual(["thread_id"])
  })
})
