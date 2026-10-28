import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendEvent, verifyEventChain } from '../src/storage.ts'

test('concurrent audit writes preserve every event and produce verifiable dossier chains', async () => {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: (k: string) => store.get(k) || null, setItem: (k: string, v: string) => store.set(k, v) }, configurable: true })
  const results = await Promise.all([
    appendEvent('case-A', 'Note', 'First note'),
    appendEvent('case-B', 'Review', 'Independent dossier'),
    appendEvent('case-A', 'Review', 'Follow-up', { result: 'eligible' }),
  ])
  const events = results.at(-1)!
  assert.equal(events.length, 3)
  assert.equal(events[2].previousHash, events[0].hash)
  assert.equal(events[1].previousHash, '0'.repeat(64))
  assert.equal(await verifyEventChain(events), true)
  assert.equal(await verifyEventChain(events.filter(e => e.companyId === 'case-A')), true)
  const altered = structuredClone(events)
  altered[0].detail = 'Changed after hashing'
  assert.equal(await verifyEventChain(altered), false)
})
