import type AIInbx from "aiinbx"
import type { Bucket } from "@upstash/blob"
import type { Redis } from "@upstash/redis"
import type { Index } from "@upstash/vector"

/** What every part of the kit works with. Built once by `createEmailKit`. */
export interface Context {
  aiinbx: AIInbx
  redis: Redis
  index: Index<ChunkMetadata>
  bucket: Bucket
  prefix: string
  limits: Limits
  /** The tenant an AI Inbx space's mail belongs to. */
  tenantOf(spaceId: string | null): string
}

export interface Limits {
  /** Attachments larger than this keep their text but not their bytes. */
  maxAttachmentBytes: number
  /** Chunks embedded per document, so one huge PDF cannot run up the bill. */
  maxChunksPerDocument: number
  /** Characters of each message `getThread` returns. */
  maxCharsPerMessage: number
}

export type ChunkMetadata = {
  email_id: string
  thread_id: string
  inboxes: string[]
  from: string
  subject: string
  /** Unix seconds, so filters can compare it. */
  created_at: number
  source: "body" | "attachment"
  attachment_id: string | null
  filename: string | null
}

/** Mail of a workspace's own domains and mailboxes, outside any space. */
export const DEFAULT_TENANT = "default"

/** The view of every inbox of a tenant, kept like an inbox of its own. */
export const ALL_INBOXES = "*"

const NAME = /^[\w.-]+$/

export function assertName(kind: "prefix" | "tenant", value: string): void {
  if (!NAME.test(value)) {
    throw new Error(`${kind} may only use letters, digits, "-", "_" and ".": ${value}`)
  }
}

/** Addresses of every tenant's inboxes: mail from one of them is from us. */
export function addressesKey(prefix: string): string {
  return `${prefix}:addresses`
}

/**
 * Everything of a tenant lives under its own key prefix, Blob folder and
 * Vector namespace: no query can cross tenants, and deleting one is a sweep
 * of three places. Within a tenant, mail is kept per inbox, the way a mail
 * client shows it: an inbox sees the messages that went through it.
 */
export function keys(prefix: string, tenant: string) {
  const t = `${prefix}:${tenant}`
  return {
    all: `${t}:*`,
    email: (id: string) => `${t}:email:${id}`,
    status: (id: string) => `${t}:email:${id}:status`,
    attachment: (id: string) => `${t}:attachment:${id}`,
    /** Subject, status and note of a thread. */
    thread: (threadId: string) => `${t}:thread:${threadId}`,
    /** The inbox's threads, scored by latest activity. */
    inbox: (inbox: string) => `${t}:inbox:${inbox}`,
    /** Drafts waiting for a person, scored by when they were written. */
    drafts: (inbox: string) => `${t}:inbox:${inbox}:drafts`,
    /** The inbox's messages of one thread, scored by time. */
    inboxThread: (inbox: string, threadId: string) => `${t}:inbox:${inbox}:thread:${threadId}`,
    handled: (emailId: string, inbox: string) => `${t}:handled:${emailId}:${inbox}`,
  }
}

export function blobPaths(prefix: string, tenant: string) {
  const t = `${prefix}/${tenant}`
  return {
    all: `${t}/`,
    html: (emailId: string) => `${t}/emails/${emailId}/body.html`,
    file: (attachmentId: string, filename: string) =>
      `${t}/attachments/${attachmentId}/${safeFilename(filename)}`,
    text: (attachmentId: string) => `${t}/attachments/${attachmentId}/content.md`,
  }
}

export function vectorNamespace(prefix: string, tenant: string): string {
  return `${prefix}:${tenant}`
}

function safeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "")
  return cleaned.slice(-120) || "file"
}
