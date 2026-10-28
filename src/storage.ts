import type { AuditEvent } from './types'

const KEY = 'creditdesk.audit.v1'
export function readEvents(): AuditEvent[] {
  try { const value = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(value) ? value : [] } catch { return [] }
}
let pendingWrite: Promise<unknown> = Promise.resolve()
export function appendEvent(companyId: string, action: string, detail: string, payload?: unknown): Promise<AuditEvent[]> {
  const next = pendingWrite.then(() => writeEvent(companyId, action, detail, payload))
  pendingWrite = next.catch(() => {})
  return next
}
async function writeEvent(companyId: string, action: string, detail: string, payload?: unknown): Promise<AuditEvent[]> {
  const events = readEvents()
  const body = {
    id: crypto.randomUUID(), companyId, time: new Date().toISOString(),
    action, detail, actor: 'Demo analyst', previousHash: events.filter(e => e.companyId === companyId).at(-1)?.hash || '0'.repeat(64),
    ...(payload === undefined ? {} : { payload }),
  }
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
  const next = [...events, { ...body, hash }]
  localStorage.setItem(KEY, JSON.stringify(next))
  return next
}
export async function verifyEventChain(events: AuditEvent[]): Promise<boolean> {
  const previous = new Map<string, string>()
  for (const event of events) {
    const { hash, ...body } = event
    if (body.previousHash !== (previous.get(body.companyId) || '0'.repeat(64))) return false
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    const calculated = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
    if (hash !== calculated) return false
    previous.set(body.companyId, hash)
  }
  return true
}
export function downloadFile(filename: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
