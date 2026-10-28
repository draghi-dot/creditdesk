import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import type { ActivityEvent } from '../src/workspace.ts'
import { verifyEventChain } from '../src/storage.ts'

// The engine chains each company's activity this way (server/workspace.ts); the browser re-verifies it.
function chain(entries: [string, string, string, unknown?][]): ActivityEvent[] {
  const heads = new Map<string, string>()
  return entries.map(([companyId, action, detail, payload]) => {
    const body = { id: randomUUID(), companyId, time: new Date().toISOString(), action, detail, actor: 'Ioana Marinescu', previousHash: heads.get(companyId) ?? '0'.repeat(64), ...(payload === undefined ? {} : { payload }) }
    const event = { ...body, hash: createHash('sha256').update(JSON.stringify(body)).digest('hex') }
    heads.set(companyId, event.hash)
    return event
  })
}

test('the browser verifies the engine\'s per-company activity chains and detects any change', async () => {
  const events = chain([['case-A', 'Note', 'First note'], ['case-B', 'Review', 'Independent dossier'], ['case-A', 'Review', 'Follow-up', { result: 'eligible' }]])
  assert.equal(events[2].previousHash, events[0].hash)
  assert.equal(events[1].previousHash, '0'.repeat(64))
  assert.equal(await verifyEventChain(events), true)
  assert.equal(await verifyEventChain(events.filter(e => e.companyId === 'case-A')), true)
  // A round trip through JSON, as the browser receives it, still verifies.
  assert.equal(await verifyEventChain(JSON.parse(JSON.stringify(events))), true)
  const altered = structuredClone(events)
  altered[0].detail = 'Changed after hashing'
  assert.equal(await verifyEventChain(altered), false)
})
