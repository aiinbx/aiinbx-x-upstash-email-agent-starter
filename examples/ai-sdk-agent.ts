/**
 * The kit with an agent on top: every email that reaches an inbox runs one
 * AI SDK agent loop with that inbox's tools. Replace the prompt with your own.
 */
import { anthropic } from "@ai-sdk/anthropic"
import { generateText, stepCountIs } from "ai"
import { createEmailKit } from "../src"
import { toAiSdkTools } from "../src/adapters/ai-sdk"
import { allOf, senderLimit, skipCategories, skipOwnInboxes } from "../src/addons/filters"

export const kit = createEmailKit({
  name: "Kestrel Assistant",
  workflow: { url: `${process.env.APP_URL}/api/email/workflow` },
  // Mail is untrusted input: a person approves what the agent writes.
  drafts: true,
  // This agent answers on its own: keep it out of mail loops and floods.
  shouldHandle: allOf(
    skipCategories("auto_reply", "out_of_office", "bounce", "spam"),
    skipOwnInboxes,
    senderLimit({ max: 20, windowSeconds: 3600 }),
  ),
  onEmail: async ({ email, inbox, tools }) => {
    await generateText({
      model: anthropic("claude-sonnet-5-5"),
      system: [
        `You answer email for ${inbox}.`,
        "Read the whole thread before you act. Search the inbox when the email refers to earlier mail or documents.",
        "Reply only when a reply is needed, then record the thread's status.",
      ].join("\n"),
      prompt: `New email in thread ${email.thread_id} from ${email.from.address}: "${email.subject}".`,
      tools: toAiSdkTools(tools),
      stopWhen: stepCountIs(12),
    })
  },
})
