// The workspace in a real (headless) browser against the real engine: company
// entry with nothing running, a live run filling the map from the event
// stream, the first finding opening its original page with outlined figures,
// Ask, and the completed assessment. Screenshots go to test-results/browser/.
//
//   npm run test:browser          (deterministic: no model, no ANAF call)
//   CREDITDESK_LLM=codex CREDITDESK_ANAF=on npm run test:browser
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { type EngineProcess, startEngine } from '../support/engine.ts'
import { type Page, launch } from '../support/browser.ts'

const COMPANY = 'TEST-DOS-018' // CONPET SA: requested amount printed differently from the recorded one
const shots = new URL('../../test-results/browser/', import.meta.url).pathname
const llm = process.env.CREDITDESK_LLM ?? 'none'
let engine: EngineProcess
let page: Page
let runId = ''

before(async () => {
  assert.ok(existsSync(new URL('../../dist/index.html', import.meta.url)), 'build the workspace first (npm run test:browser does)')
  engine = await startEngine({ CREDITDESK_LLM: llm, CREDITDESK_ANAF: process.env.CREDITDESK_ANAF ?? 'off' })
  page = await launch()
})
after(async () => { await page?.close(); await engine?.stop() })

interface Sample { t: number; status: string | null; nodes: Record<string, number>; evidence: boolean; issue: number; reference: number; highlighted: boolean }
const SAMPLE = `(() => {
  const nodes = {}
  for (const el of document.querySelectorAll('.map-node')) { const s = [...el.classList].find(c => /^map-(waiting|running|done|attention|failed|cancelled)$/.test(c)); nodes[s] = (nodes[s] || 0) + 1 }
  const img = document.querySelector('.evidence-page img')
  return { t: Date.now(), status: document.querySelector('.run-page')?.dataset.runStatus ?? null, nodes, evidence: !!img && img.complete && img.naturalWidth > 0,
    issue: document.querySelectorAll('.evidence-mark.mark-issue').length, reference: document.querySelectorAll('.evidence-mark.mark-reference').length,
    highlighted: !!document.querySelector('.map-node.map-highlight') }
})()`

test('opening a company runs nothing and offers the two actions', async () => {
  await page.goto(engine.url + '/#/companies/' + COMPANY)
  await page.waitFor(`[...document.querySelectorAll('.entry-choice h2')].map(h => h.textContent).join('|') === 'View assessment|Run new assessment'`, 'the two actions')
  assert.ok(await page.eval(`document.body.textContent.includes('No completed assessment')`))
  assert.equal(await page.eval(`[...document.querySelectorAll('.entry-choice button')].find(b => b.textContent.includes('View assessment')).disabled`), true)
  await page.screenshot(shots + '1-entry.png')
  assert.deepEqual((await engine.get('/companies/' + COMPANY + '/runs')).runs, [], 'nothing ran on open')
})

test('a live run fills the map from the stream and opens the first finding on its original page, outlined', async () => {
  await page.click('.entry-choice button', 'Run new assessment')
  runId = (await page.waitFor<string>(`location.hash.match(/\\/run\\/([0-9a-f-]{36})/)?.[1]`, 'the live run page'))
  const samples: Sample[] = []
  let liveShot = false
  const deadline = Date.now() + (llm === 'none' ? 30_000 : 300_000)
  for (;;) {
    const s = await page.eval<Sample>(SAMPLE)
    samples.push(s)
    if (s.evidence && s.issue && !liveShot) { liveShot = true; await page.screenshot(shots + '2-live-evidence.png') }
    if (s.status && s.status !== 'running' && s.status !== 'created') break
    if (Date.now() > deadline) throw new Error('the run did not finish in time')
  }
  assert.equal(samples.at(-1)!.status, 'completed')
  // The map was seen part-way: workers missing, waiting or working before everything was done.
  const total = (s: Sample) => Object.values(s.nodes).reduce((a, b) => a + b, 0)
  const settled = (s: Sample) => (s.nodes['map-done'] ?? 0) + (s.nodes['map-attention'] ?? 0)
  assert.ok(samples.some(s => s.status === 'running' && (total(s) < 10 || settled(s) < total(s))), 'map observed before every worker finished')
  await page.waitFor(`document.querySelectorAll('.map-node.map-done, .map-node.map-attention').length === 10`, 'all ten workers settled')
  // The first finding opens by itself (no click): its original page renders with the problem in red, and the
  // producing worker is highlighted. Without a model the run can finish before the page image has rendered.
  const opened = samples.find(s => s.evidence && s.issue > 0) ?? await page.waitFor<Sample>(`(() => { const s = ${SAMPLE}; return s.evidence && s.issue > 0 && s })()`, 'the first finding to open on its page')
  assert.ok(opened.highlighted, 'producing worker highlighted on the map')
  assert.match(await page.eval(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent`), /^Evidence/, 'the Evidence tab opened by itself')
  if (!liveShot) await page.screenshot(shots + '2-live-evidence.png')
  // Every outline sits on the rendered page image.
  const placement = await page.eval<{ inside: boolean; marks: number }>(`(() => {
    const img = document.querySelector('.evidence-page img').getBoundingClientRect()
    const marks = [...document.querySelectorAll('.evidence-mark')].map(m => m.getBoundingClientRect())
    return { marks: marks.length, inside: marks.every(r => r.left >= img.left - 2 && r.top >= img.top - 2 && r.right <= img.right + 2 && r.bottom <= img.bottom + 2) }
  })()`)
  assert.ok(placement.marks > 0 && placement.inside, JSON.stringify(placement))
  // The comparison (blue) is shown on the page of the document it was compared with.
  if (!await page.eval(`document.querySelectorAll('.evidence-mark.mark-reference').length`)) {
    await page.click('.evidence-tabs button', 'Draft financing contract')
    await page.waitFor(`document.querySelectorAll('.evidence-mark.mark-reference').length > 0`, 'comparison outlined in blue')
  }
  await page.screenshot(shots + '3-run-completed.png')
  assert.deepEqual(page.errors, [])
})

test('Ask answers inside the workspace and says which model answered', async () => {
  await page.click('[role="tab"]', 'Ask')
  if (llm === 'none') await page.waitFor(`document.querySelector('.ask-model-off')?.textContent.includes('No model connected')`, 'the no-model notice')
  await page.click('.ask-suggest button', 'What is the biggest problem?')
  const answer = await page.waitFor<{ text: string; meta: string }>(`(() => { const a = [...document.querySelectorAll('.ask-a:not(.ask-pending)')].at(-1); return a && { text: a.querySelector('p').textContent, meta: a.querySelector('.ask-meta').textContent } })()`, 'an answer', llm === 'none' ? 15_000 : 180_000)
  assert.ok(answer.text.length > 20, answer.text)
  assert.match(answer.meta, llm === 'none' ? /engine · no model/ : /Codex/)
  await page.screenshot(shots + '4-ask.png')
})

test('View assessment then opens the completed run', async () => {
  await page.goto(engine.url + '/#/companies/' + COMPANY)
  await page.waitFor(`[...document.querySelectorAll('.entry-choice button')].some(b => b.textContent.includes('View assessment') && !b.disabled)`, 'View assessment enabled')
  await page.click('.entry-choice button', 'View assessment')
  await page.waitFor(`location.hash.includes('/assessment/${runId}')`, 'the completed assessment route')
  await page.waitFor(`document.querySelectorAll('.map-node').length === 10`, 'the recorded map')
  await page.screenshot(shots + '5-assessment.png')
  assert.deepEqual(page.errors, [])
})
