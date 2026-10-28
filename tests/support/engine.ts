/**
 * The real engine process (server/index.ts) on a free port with its own data
 * folder, for tests that go through HTTP and the live run stream.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunEvent } from '../../src/assessment.ts'

export interface EngineProcess {
  url: string
  get<T = any>(path: string): Promise<T>
  post<T = any>(path: string, body?: unknown): Promise<T>
  log(): string
  stop(): Promise<void>
}

export const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number }
    probe.close(() => resolve(port))
  })
})

export async function startEngine(env: Record<string, string>): Promise<EngineProcess> {
  const port = await freePort()
  const data = mkdtempSync(join(tmpdir(), 'creditdesk-engine-'))
  const child = spawn(process.execPath, ['server/index.ts'], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), CREDITDESK_DATA: data, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const url = 'http://127.0.0.1:' + port
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + '/api' + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(method + ' ' + path + ' → ' + res.status + ': ' + JSON.stringify(json))
    return json
  }
  const deadline = Date.now() + 20_000
  for (;;) {
    if (child.exitCode !== null) throw new Error('The engine exited during startup:\n' + output)
    try { if ((await fetch(url + '/api/health')).ok) break } catch { /* not listening yet */ }
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error('The engine did not start within 20 s:\n' + output) }
    await new Promise(r => setTimeout(r, 100))
  }
  return {
    url,
    get: path => call('GET', path),
    post: (path, body) => call('POST', path, body ?? {}),
    log: () => output,
    stop: () => new Promise(resolve => {
      const done = () => { rmSync(data, { recursive: true, force: true }); resolve() }
      if (child.exitCode !== null) return done()
      child.once('exit', done)
      child.kill('SIGTERM')
    }),
  }
}

export interface Arrival { event: RunEvent; at: number }

/** Reads a run's live stream until the engine ends it, noting when each event arrived. */
export async function readStream(url: string): Promise<{ arrivals: Arrival[]; connectedAt: number }> {
  const res = await fetch(url, { headers: { accept: 'text/event-stream' } })
  if (!res.ok || !res.body) throw new Error('stream answered ' + res.status)
  const connectedAt = Date.now()
  const decoder = new TextDecoder()
  const arrivals: Arrival[] = []
  let buffer = ''
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const type = /^event: (.*)$/m.exec(block)?.[1]
      const data = /^data: (.*)$/m.exec(block)?.[1]
      if (type === 'run' && data) arrivals.push({ event: JSON.parse(data), at: Date.now() })
      if (type === 'end') return { arrivals, connectedAt }
    }
  }
  return { arrivals, connectedAt }
}

/** Width and height from a PNG header. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!signature.every((b, i) => png[i] === b)) throw new Error('not a PNG')
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}
