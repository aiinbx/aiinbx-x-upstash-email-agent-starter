/**
 * Creates the Upstash Redis database, Vector index and Blob bucket, and
 * writes their credentials and the local webhook secret to `.env.local`.
 *
 *   npx @upstash/cli login          # once
 *   npm run setup                   # or: npm run setup -- my-agent
 *
 * Put `AI_INBX_API_KEY` in `.env.local` first, so the webhook secret can be
 * fetched too. Regions are the defaults below; change them to be near your app.
 */
import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

const name = process.argv[2] ?? "email-agent"
const ENV = ".env.local"

if (!existsSync(ENV)) copyFileSync(".env.example", ENV)

const redis = upstash("redis", "create", "--name", name, "--region", "eu-central-1")
setEnv("UPSTASH_REDIS_REST_URL", `https://${redis.endpoint}`)
setEnv("UPSTASH_REDIS_REST_TOKEN", redis.rest_token)
console.log(`✓ Redis ${redis.endpoint}`)

// Hybrid: OpenAI's text-embedding-3-small for meaning, BM25 for exact words.
// Upstash runs both models; no OpenAI key needed.
const vector = upstash(
  "vector",
  "create",
  "--name",
  name,
  "--region",
  "eu-west-1",
  "--type",
  "payg",
  "--index-type",
  "HYBRID",
  "--embedding-model",
  "TEXT_EMBEDDING_3_SMALL",
  "--sparse-embedding-model",
  "BM25",
  "--similarity-function",
  "COSINE",
  "--dimension-count",
  "1536",
)
setEnv("UPSTASH_VECTOR_REST_URL", `https://${vector.endpoint}`)
setEnv("UPSTASH_VECTOR_REST_TOKEN", vector.token)
console.log(`✓ Vector ${vector.endpoint}`)

upstash("blob", "create", "--name", name, "--write-env", ENV)
console.log(`✓ Blob ${name}`)

if (readEnv("AI_INBX_API_KEY")) {
  const secret = run("npx", ["--yes", "@aiinbx/cli", "listen", "--print-secret"])
    .trim()
    .split(/\s+/)
    .pop()!
  setEnv("AI_INBX_WEBHOOK_SECRET", secret)
  console.log("✓ AI Inbx webhook secret for local dev")
} else {
  console.log("! Add AI_INBX_API_KEY to .env.local and run setup again for the webhook secret")
}
console.log(`\nDone. Set AGENT_INBOX in ${ENV}, then: npm run dev`)

function upstash(...args: string[]) {
  return JSON.parse(run("npx", ["--yes", "@upstash/cli", ...args]))
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
}

function readEnv(key: string): string | undefined {
  return readFileSync(ENV, "utf8")
    .match(new RegExp(`^${key}=(.+)$`, "m"))?.[1]
    ?.trim()
}

/** Replace the variable's line, or add one: never two lines for one variable. */
function setEnv(key: string, value: string): void {
  const text = readFileSync(ENV, "utf8")
  const line = `${key}=${value}`
  const pattern = new RegExp(`^${key}=.*$`, "m")
  writeFileSync(
    ENV,
    pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`,
  )
}
