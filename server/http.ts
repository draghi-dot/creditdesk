import type { IncomingMessage, ServerResponse } from 'node:http'

export const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export async function readJson(req: IncomingMessage): Promise<any> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 64 * 1024) throw Object.assign(new Error('request too large'), { status: 413 })
  }
  return raw ? JSON.parse(raw) : {}
}
