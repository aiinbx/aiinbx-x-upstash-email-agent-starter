import { createServer } from "node:http"

/** A web-standard handler on Node's http server, the smallest adapter there is. */
export function serve(port: number, handler: (request: Request) => Promise<Response> | Response) {
  createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const headers = new Headers()
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value)
    }
    try {
      const response = await handler(
        new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers, body }),
      )
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch (error) {
      console.error(error)
      res.writeHead(500).end()
    }
  }).listen(port)
}
