import type { AuditEvent } from './types'

/** Recompute each company's activity chain in the browser, independently of the engine. */
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
