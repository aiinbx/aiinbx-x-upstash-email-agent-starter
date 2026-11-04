import type { AttachmentPreparation, EmailCategory, EmailStatus } from "aiinbx"

/** An email as the kit keeps it in Redis: what an agent needs, nothing more. */
export interface StoredEmail {
  id: string
  thread_id: string
  /** The tenant the email belongs to: its AI Inbx space, or `default`. */
  tenant: string
  space_id: string | null
  direction: "inbound" | "outbound"
  from: { name: string | null; address: string }
  to: string[]
  cc: string[]
  /** Where replies go instead of the sender, when the sender asked for that. */
  reply_to: string[]
  subject: string
  /** What this message says, quoted conversation and repeated signature removed. */
  text: string
  category: EmailCategory | null
  message_id: string
  in_reply_to: string | null
  created_at: string
  /** Our addresses this email went through. Tools only see mail of their inbox. */
  inboxes: string[]
  attachments: AttachmentRef[]
}

export interface AttachmentRef {
  id: string
  filename: string
  content_type: string
  size: number
  /** Whether `read_attachment` can return text for it. */
  has_text: boolean
}

export interface StoredAttachment extends AttachmentRef {
  email_id: string
  thread_id: string
  inboxes: string[]
  /** Blob path of the original bytes. Null when over the size cap or no longer at AI Inbx. */
  blob_path: string | null
  /** Blob path of the extracted Markdown or plain text. */
  text_path: string | null
  text_status: AttachmentPreparation["status"] | null
}

export interface ThreadSummary {
  id: string
  subject: string
  status: string | null
  note: string | null
  message_count: number
  last_message_at: string
  last_message: {
    id: string
    from: string
    direction: StoredEmail["direction"]
    snippet: string
  } | null
}

export interface SearchHit {
  email_id: string
  thread_id: string
  from: string
  subject: string
  created_at: string
  /** The email body or one of its attachments. */
  source: "body" | "attachment"
  attachment_id: string | null
  filename: string | null
  excerpt: string
  score: number
}

/** Delivery status of an email we sent, updated from webhook events. */
export type DeliveryStatus = Extract<EmailStatus, "delivered" | "bounced" | "failed" | "complained">
