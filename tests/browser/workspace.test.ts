// The workspace in a real (headless) browser against the real engine: company
// entry with nothing running, a live run filling the map from the event
// stream, the first finding opening its original page with outlined figures,
// Ask, the completed assessment, and the people side: sending a problem to a
// department, the case page, switching employee. Screenshots go to test-results/browser/.
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
  await page.waitFor(`[...document.querySelectorAll('.verdict-actions button')].map(b => b.textContent).join('|') === 'View assessment|Run assessment'`, 'the two actions')
  assert.ok(await page.eval(`document.querySelector('.verdict').textContent.includes('Not assessed yet')`))
  assert.equal(await page.eval(`[...document.querySelectorAll('.verdict-actions button')].find(b => b.textContent.includes('View assessment')).disabled`), true)
  await page.screenshot(shots + '1-entry.png')
  assert.deepEqual((await engine.get('/companies/' + COMPANY + '/runs')).runs, [], 'nothing ran on open')
})

test('a live run fills the map from the stream and opens the first finding on its original page, outlined', async () => {
  await page.click('.verdict-actions button', 'Run assessment')
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
  await page.waitFor(`!!document.querySelector('.ws-top.map-collapsed')`, 'the map folding aside after the run')
  // Once the run is done its activity is no longer a tab; the evidence is, next to the problems to solve.
  assert.deepEqual(await page.eval(`[...document.querySelectorAll('.ws-tabs [role="tab"]')].map(t => t.textContent.replace(/\\d+$/, ''))`), ['Problems', 'Ask', 'Sources'])
  assert.match(await page.eval(`document.querySelector('.ws-tabs [aria-selected="true"]').textContent`), /^Problems/)
  // The outlined line is also shown enlarged beside the page.
  assert.ok(await page.eval(`document.querySelectorAll('.closeup .closeup-crop').length > 0`), 'enlarged lines beside the page')
  // The first finding opens by itself (no click): its original page renders with the problem in red, and the
  // producing worker is highlighted. Without a model the run can finish before the page image has rendered.
  const opened = samples.find(s => s.evidence && s.issue > 0) ?? await page.waitFor<Sample>(`(() => { const s = ${SAMPLE}; return s.evidence && s.issue > 0 && s })()`, 'the first finding to open on its page')
  assert.ok(opened.highlighted, 'producing worker highlighted on the map')
  assert.match(await page.eval(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent`), /^Problems/, 'the problems view opened by itself')
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
  // Asking from an outlined figure names it and asks straight away.
  await page.click('[role="tab"]', 'Problems')
  await page.waitFor(`document.querySelector('.closeup-ask')`, 'the enlarged lines')
  await page.eval(`document.querySelector('.closeup-ask').click()`)
  const asked = await page.waitFor<string>(`document.querySelector('.ws-tabs [aria-selected="true"]')?.textContent.startsWith('Ask') && [...document.querySelectorAll('.ask-q')].at(-1)?.textContent`, 'the question about the figure')
  assert.match(asked, /^“.+” \(.+, page \d+\): why is this a problem, and what would resolve it\?$/)
})

test('View assessment then opens the completed run', async () => {
  await page.goto(engine.url + '/#/companies/' + COMPANY)
  await page.waitFor(`[...document.querySelectorAll('.verdict-actions button')].some(b => b.textContent.includes('View assessment') && !b.disabled)`, 'View assessment enabled')
  await page.click('.verdict-actions button', 'View assessment')
  await page.waitFor(`location.hash.includes('/assessment/${runId}')`, 'the completed assessment route')
  await page.waitFor(`document.querySelectorAll('.map-node').length === 10`, 'the recorded map')
  await page.screenshot(shots + '5-assessment.png')
  assert.deepEqual(page.errors, [])
})

test('a problem is sent to its department from the assessment and opens as a case there', async () => {
  await page.goto(engine.url + '/#/companies/' + COMPANY + '/assessment/' + runId)
  await page.waitFor(`document.querySelector('.pnav-row.active') && document.querySelector('.finding-actions')`, 'the problems with the first one open')
  await page.click('.finding-actions button', 'Send to Finance')
  await page.waitFor(`document.querySelector('dialog[open] .department-choice label.checked')?.textContent.startsWith('Finance')`, 'Finance chosen already')
  await page.type('dialog[open] textarea', 'Please confirm which amount the client applied for.')
  await page.click('dialog[open] button[type="submit"]', 'Send to Finance')
  const chip = await page.waitFor<string>(`document.querySelector('.finding-actions .sent-to')?.textContent`, 'the case chip on the problem')
  assert.match(chip, /^#\d+ · Finance · Open/)
  await page.goto(engine.url + '/#/departments/finance')
  await page.waitFor(`document.querySelectorAll('.case-table tbody tr').length === 1`, 'the case in Finance')
  await page.click('.case-table tbody tr')
  await page.waitFor(`document.querySelector('.case-header h1')?.textContent.includes('Requested amount')`, 'the case page')
  await page.waitFor(`(() => { const img = document.querySelector('.case-evidence .evidence-page img'); return img && img.complete && img.naturalWidth > 0 })()`, 'the evidence page on the case')
  // Opening the case started the assistant: it looks up the contact, then suggests the email.
  await page.waitFor(`document.querySelectorAll('.request-list > li').length === 1 && !document.querySelector('.assistant-working')`, 'the suggested email', 30_000)
  const timeline = await page.eval<{ who: string; note: string }[]>(`[...document.querySelectorAll('.timeline li')].map(li => ({ who: li.querySelector('p').textContent.replace(li.querySelector('time').textContent, ''), note: li.querySelector('blockquote')?.textContent ?? '' }))`)
  assert.deepEqual(timeline.map(t => t.who), ['Ioana Marinescu sent this problem to Finance', 'Assistant looked up the company contact', 'Assistant suggested an email to the company'])
  assert.equal(timeline[0].note, 'Please confirm which amount the client applied for.')
  assert.match(await page.eval(`document.querySelector('.delivery-mode').textContent`), /^Simulated sending: Send records the email as sent/)
  await page.screenshot(shots + '6-case.png')
  assert.deepEqual(page.errors, [])
})

test('the employee can be switched from the menu', async () => {
  await page.click('.sidebar .profile')
  await page.waitFor(`document.querySelector('.user-menu')`, 'the employee menu')
  await page.click('.user-menu-group button', 'Andrei Popa')
  await page.waitFor(`document.querySelector('.sidebar .profile strong')?.textContent === 'Andrei Popa'`, 'Andrei Popa signed in')
  assert.equal((await engine.get('/me')).user.name, 'Ioana Marinescu', 'the engine default is unchanged; the browser sends its choice per request')
})

test('a missing required document is the first thing on the company page, with its upload', async () => {
  await page.goto(engine.url + '/#/companies/TEST-DOS-002')
  const alert = await page.waitFor<string>(`document.querySelector('.missing-alert')?.textContent`, 'the missing-document alert')
  assert.ok(alert.includes('Cash-flow history & projection') && alert.includes('Upload PDF'))
  assert.equal(await page.eval(`document.querySelector('.missing-alert').compareDocumentPosition(document.querySelector('.entry-actions')) & Node.DOCUMENT_POSITION_FOLLOWING`), 4, 'shown above the assessment actions')
  await page.screenshot(shots + '7-missing-document.png')
})
