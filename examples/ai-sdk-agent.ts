/**
 * An agent on top of the kit: every email that reaches an inbox runs one AI
 * SDK loop with that inbox's tools. It writes drafts for a person to approve,
 * and stays out of mail loops and floods. `npm run dev` uses it when
 * `ANTHROPIC_API_KEY` is set. In your app:
 *
 *   createEmailKit({ workflow: { url: "https://your.app/api/email/workflow" }, ...draftingAgent })
 */
import { anthropic } from "@ai-sdk/anthropic"
import { generateText, stepCountIs } from "ai"
import type { EmailKitOptions } from "../src"
import { toAiSdkTools } from "../src/adapters/ai-sdk"
import { allOf, senderLimit, skipCategories, skipOwnInboxes } from "../src/addons/filters"

export const draftingAgent = {
  // Mail is untrusted input: a person approves what the agent writes.
  drafts: true,
  shouldHandle: allOf(
    skipCategories("auto_reply", "out_of_office", "bounce", "spam"),
    skipOwnInboxes,
    senderLimit({ max: 20, windowSeconds: 3600 }),
  ),
  onEmail: async ({ email, inbox, tools }) => {
    const { steps } = await generateText({
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
    const used = steps.flatMap((s) => s.toolCalls.map((c) => c.toolName))
    console.log(`[agent] ${email.thread_id}: ${used.join(", ") || "no tools"}`)
  },
} satisfies Pick<EmailKitOptions, "drafts" | "shouldHandle" | "onEmail">
