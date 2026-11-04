const TARGET = 1_800
const OVERLAP = 200

/**
 * Split text into overlapping chunks for embedding, breaking at paragraph,
 * then line, then sentence boundaries where one is close to the target size.
 */
export function chunk(text: string, max: number): string[] {
  const clean = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (!clean) return []
  const chunks: string[] = []
  let start = 0
  while (start < clean.length && chunks.length < max) {
    let end = Math.min(start + TARGET, clean.length)
    if (end < clean.length) end = breakPoint(clean, start, end)
    chunks.push(clean.slice(start, end).trim())
    if (end >= clean.length) break
    start = Math.max(end - OVERLAP, start + 1)
  }
  return chunks.filter(Boolean)
}

function breakPoint(text: string, start: number, end: number): number {
  const floor = start + TARGET / 2
  for (const separator of ["\n\n", "\n", ". "]) {
    const at = text.lastIndexOf(separator, end)
    if (at > floor) return at + separator.length
  }
  return end
}
