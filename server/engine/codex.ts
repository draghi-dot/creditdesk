/**
 * Codex model calls, after Baton's Codex runtime (orchestrator/app/src/main/
 * runtimes/codex.ts). Runs the official CLI headless (`codex exec --json`)
 * under whatever account the operator signed in with; the engine never reads
 * that credential.
 *
 * Isolation: user config, execpolicy rules and AGENTS.md are ignored, shell
 * and web search are off, the sandbox is read-only and the working directory
 * is an empty scratch folder. The model only sees the prompt it is given and
 * must answer in the supplied JSON schema. Completion authority is
 * `turn.completed`; anything else is an error, never a result.
 */

import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

export interface CodexConfig {
  command: string
  model: string
  effort: string
  timeoutMs: number
}

export interface ModelAnswer<T> {
  ok: boolean
  value: T | null
  reason: string
  durationMs: number
  usage?: Record<string, unknown>
}

type Frame = Record<string, any>

const toml = (value: string) => JSON.stringify(value)

export function codexArgs(config: CodexConfig, scratch: string, schemaFile: string): string[] {
  return [
    'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules',
    '--sandbox', 'read-only', '--color', 'never', '-C', scratch,
    '-c', 'approval_policy="never"',
    '-c', 'features.shell_tool=false',
    '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0',
    '-c', 'model_reasoning_effort=' + toml(config.effort),
    '-m', config.model,
    '--output-schema', schemaFile,
    '-',
  ]
}

function stop(child: ReturnType<typeof spawn>) {
  const kill = (sig: NodeJS.Signals) => {
    if (child.exitCode !== null) return
    try { if (child.pid !== undefined) process.kill(-child.pid, sig); else child.kill(sig) } catch { try { child.kill(sig) } catch { /* gone */ } }
  }
  kill('SIGTERM')
  setTimeout(() => kill('SIGKILL'), 2000).unref()
}

export function askCodex<T>(config: CodexConfig, prompt: string, schema: object, signal: AbortSignal): Promise<ModelAnswer<T>> {
  const started = Date.now()
  const scratch = mkdtempSync(join(tmpdir(), 'creditdesk-codex-'))
  const schemaFile = join(scratch, 'schema.json')
  writeFileSync(schemaFile, JSON.stringify(schema))
  return new Promise(resolve => {
    let settled = false
    let stderr = ''
    let lastMessage: string | null = null
    let lastError: string | null = null
    let completed: Frame | null = null
    const child = spawn(config.command, codexArgs(config, scratch, schemaFile), { cwd: scratch, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    const timer = setTimeout(() => finish(false, 'timed out after ' + Math.round(config.timeoutMs / 1000) + ' s'), config.timeoutMs)
    const onAbort = () => finish(false, 'cancelled')
    signal.addEventListener('abort', onAbort, { once: true })

    function finish(ok: boolean, reason: string, value: T | null = null, usage?: Record<string, unknown>) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      stop(child)
      rmSync(scratch, { recursive: true, force: true })
      resolve({ ok, value, reason, usage, durationMs: Date.now() - started })
    }

    child.on('error', err => finish(false, 'could not start Codex (' + config.command + '): ' + err.message))
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-4000) })
    child.on('close', code => {
      if (completed && lastMessage !== null) {
        try { return finish(true, 'answered', JSON.parse(lastMessage) as T, completed.usage) }
        catch { return finish(false, 'the answer was not valid JSON') }
      }
      const first = lastError ?? stderr.split('\n').map(l => l.trim()).find(Boolean)
      finish(false, 'Codex exited (code ' + code + ') without completing its turn' + (first ? ': ' + first.slice(0, 300) : ''))
    })
    createInterface({ input: child.stdout }).on('line', line => {
      if (settled || !line.trim()) return
      let frame: Frame
      try { frame = JSON.parse(line) } catch { return }
      if (frame.type === 'item.completed' && frame.item?.type === 'agent_message' && typeof frame.item.text === 'string') lastMessage = frame.item.text
      else if (frame.type === 'item.completed' && frame.item?.type === 'error') lastError = String(frame.item.message)
      else if (frame.type === 'error') lastError = String(frame.message ?? JSON.stringify(frame))
      else if (frame.type === 'turn.failed') lastError = String(frame.error?.message ?? lastError ?? 'turn failed')
      else if (frame.type === 'turn.completed') completed = frame
    })
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

/** Whether the CLI exists and has a signed-in account. */
export function codexStatus(command: string): Promise<{ available: boolean; detail: string }> {
  return new Promise(resolve => {
    execFile(command, ['login', 'status'], { timeout: 10_000 }, (err, stdout, stderr) => {
      const text = (stdout + stderr).trim()
      if (err && !text) return resolve({ available: false, detail: err.message })
      resolve({ available: /logged in/i.test(text) && !/not logged in/i.test(text), detail: text.split('\n')[0] ?? '' })
    })
  })
}
