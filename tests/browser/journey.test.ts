// The whole workspace clicked through as the bank's employees would, in a real
// (headless) browser against the real engine: the day's overview, the
// companies, an eligible application taken all the way to a signed client,
// problems sent to Legal and Finance and worked there, a missing document, a
// decline, a remedy in the scenarios, and an early warning on a credit client.
// No model and no network: the engine writes the assistant's texts itself, and
// the news signal is a planted test. Screenshots go to test-results/journey/.
//
//   npm run test:browser
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { type EngineProcess, startEngine } from '../support/engine.ts'
import { type Page, launch } from '../support/browser.ts'

const shots = new URL('../../test-results/journey/', import.meta.url).pathname
let engine: EngineProcess
let page: Page
const post = (path: string, body: unknown = {}, user = 'u-legal-1') => fetch(engine.url + '/api' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-user': user }, body: JSON.stringify(body) }).then(r => r.json())
const text = (selector: string) => page.eval<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`)
const count = (selector: string) => page.eval<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
const choose = async (select: string, option: string) => { await page.click(select); await page.waitFor(`document.querySelector('.select-popover')`, 'the dropdown'); await page.click('.select-option', option) }
const settle = (ms = 400) => new Promise(r => setTimeout(r, ms))
/** Opens a company and runs a new assessment from its page, until the run is done. */
async function assess(id: string) {
  await page.goto(engine.url + '/#/companies/' + id)
  await page.waitFor(`document.querySelector('.verdict-actions')`, 'the company page')
  await page.click('.verdict-actions button', 'Run')
  await page.waitFor(`document.querySelector('.run-page')?.dataset.runStatus === 'completed'`, 'the run to finish', 60_000)
  return page.eval<string>(`location.hash.match(/run\\/([0-9a-f-]{36})/)[1]`)
}

before(async () => {
  engine = await startEngine({ CREDITDESK_LLM: 'none', CREDITDESK_ANAF: 'off', CREDITDESK_MONITOR_WEB: 'off', CREDITDESK_SEND_DELAY_MS: '50' })
  page = await launch(1440, 940)
})
after(async () => { await page?.close(); await engine?.stop() })

test('the day opens on Today, and the companies can be filtered, searched and switched between grid and table', async () => {
  await page.goto(engine.url + '/#/overview')
  await page.waitFor(`document.querySelector('.today-head h1')?.textContent.startsWith('Good')`, 'Today')
  assert.ok(await count('.task') > 0, 'the agenda has work')
  await page.screenshot(shots + '01-today.png')
  await page.goto(engine.url + '/#/companies')
  await page.waitFor(`document.querySelectorAll('.company-card').length === 12`, 'the first page of cards')
  assert.match(await text('.page-heading .companies-tabs'), /Applications50Credit clients11/)
  await choose('.select.sector-select', 'Aerospace')
  await page.waitFor(`[...document.querySelectorAll('.company-card .cc-sub')].every(s => s.textContent.startsWith('Aerospace'))`, 'only aerospace companies')
  await page.click('.selection-bar .clear-filters')
  await page.type('.directory-toolbar input', 'sphera')
  await page.waitFor(`document.querySelectorAll('.company-card').length === 1 && document.querySelector('.company-card h3').textContent === 'SPHERA FRANCHISE GROUP'`, 'the search result')
  await page.click('.view-toggle button[aria-label="Table view"]')
  await page.waitFor(`document.querySelectorAll('.company-table tbody tr').length === 1`, 'the table view')
  await page.click('.view-toggle button[aria-label="Grid view"]')
  assert.deepEqual(page.errors, [])
})

test('an eligible application goes all the way: assessed, every section reviewed, recommended, approved by a colleague, sent and signed', async () => {
  await assess('TEST-DOS-001')
  await page.waitFor(`document.querySelector('.all-clear') && !document.querySelector('.ws-top.live-run')`, 'no problems, the map folded aside', 10_000)
  await page.click('.run-header-actions button', 'Open full assessment')
  await page.waitFor(`document.querySelectorAll('.flow-tabs [role="tab"]').length === 6`, 'the path of tabs')
  for (const section of ['Assessment', 'Financials', 'Documents', 'Scenarios', 'Activity & checks']) {
    await page.waitFor(`document.querySelector('.review-bar strong')?.textContent.includes(${JSON.stringify(section.toLowerCase())})`, section + ' review bar')
    await page.click('.review-bar button', 'Mark reviewed')
    await page.waitFor(`document.querySelector('.review-bar.done')`, section + ' marked reviewed')
    await page.eval(`[...document.querySelectorAll('.review-bar button')].at(-1).click()`)
    await settle(250)
  }
  await page.waitFor(`document.querySelector('.decision-hero')`, 'the decision')
  assert.equal(await count('.flow-tabs .flow-tick'), 5)
  await page.click('.ds-action button', 'Record recommendation')
  await page.waitFor(`document.querySelector('dialog[open] textarea')`, 'the recommendation dialog')
  await page.eval(`document.querySelector('dialog[open] input[value="approval"]').click()`)
  await page.type('dialog[open] textarea', 'Clean dossier, coverage well above policy; I recommend approval.')
  await page.click('dialog[open] button[type="submit"]')
  await page.waitFor(`document.querySelector('.decision-hero h2')?.textContent.startsWith('Recommended')`, 'the recommendation recorded')
  // Four eyes: the analyst who recommended hands the approval to a colleague.
  await choose('.ds-action .select', 'Cristina Dobre')
  await page.waitFor(`document.querySelector('.decision-hero h2')?.textContent.startsWith('Approved')`, 'the approval', 10_000)
  await page.click('.ds-action button', 'Send contract')
  await page.waitFor(`document.querySelector('.decision-hero h2')?.textContent.startsWith('Sent for signature')`, 'the contract sent')
  await page.click('.ds-action button', 'Record signature')
  await page.waitFor(`document.querySelector('.decision-hero.signed')`, 'signed')
  await page.screenshot(shots + '02-signed.png')
  await page.goto(engine.url + '/#/clients')
  await page.waitFor(`[...document.querySelectorAll('.clients-table .company-name')].some(n => n.textContent === 'AAGES S.A.')`, 'AAGES among the credit clients')
  assert.match(await text('.page-heading .companies-tabs'), /Applications49Credit clients12/)
  assert.deepEqual(page.errors, [])
})

test('two problems go to Legal and Finance; the Legal employee works the case and sends the email the assistant suggested', async () => {
  await post('/companies/TEST-DOS-048/contacts', { name: 'Andreea Ionescu', role: 'Chief financial officer', email: 'andreea.ionescu@sphera.example.ro', phone: '' })
  await assess('TEST-DOS-048')
  await page.waitFor(`document.querySelectorAll('.pnav-row').length === 2`, 'two problems to solve', 10_000)
  const titles = await page.eval<string[]>(`[...document.querySelectorAll('.pnav-title')].map(t => t.textContent)`)
  assert.deepEqual(titles.sort(), ['Accepted collateral coverage needs review', 'Litigation exposure needs review'])
  for (const [title, department] of [['Litigation exposure needs review', 'Legal'], ['Accepted collateral coverage needs review', 'Finance']]) {
    await page.click('.pnav-row', title)
    await page.waitFor(`document.querySelector('.finding-detail h3')?.textContent === ${JSON.stringify(title)}`, title)
    await page.click('.finding-actions button', 'Send to ' + department)
    await page.waitFor(`document.querySelector('dialog[open] .department-choice label.checked')?.textContent.startsWith(${JSON.stringify(department)})`, department + ' chosen already')
    await page.click('dialog[open] button[type="submit"]')
    await page.waitFor(`document.querySelector('.finding-actions .sent-to')?.textContent.includes(${JSON.stringify(department)})`, 'the case chip')
  }
  await page.goto(engine.url + '/#/departments/legal')
  await page.waitFor(`[...document.querySelectorAll('.case-table tbody tr')].some(r => r.textContent.includes('Litigation exposure'))`, 'the case in Legal')
  await page.click('.case-table tbody tr', 'Litigation exposure')
  await page.waitFor(`document.querySelectorAll('.request-list > li').length >= 1 && !document.querySelector('.assistant-working')`, 'the suggested email', 30_000)
  await page.eval(`document.querySelector('.request-actions') || document.querySelector('.request-row').click()`)
  await page.waitFor(`document.querySelector('.request-actions button')`, 'the email editor')
  await page.click('.request-actions button', 'Send')
  await page.waitFor(`document.querySelector('.sent-confirm')`, 'the email recorded as sent', 10_000)
  assert.match(await text('.sent-confirm'), /Simulated delivery: recorded as sent, no email left Finra\./)
  await page.waitFor(`[...document.querySelectorAll('.timeline li')].some(li => li.textContent.includes('sent the request to Andreea Ionescu'))`, 'the email in the case timeline')
  await page.screenshot(shots + '03-case.png')
  assert.deepEqual(page.errors, [])
})

test('a missing document is shown first; the run says what it blocks and a request to the company is drafted and sent', async () => {
  await post('/companies/TEST-DOS-022/contacts', { name: 'Mihai Stan', role: 'Finance director', email: 'mihai.stan@remedia.example.ro', phone: '' })
  await page.goto(engine.url + '/#/companies/TEST-DOS-022')
  await page.waitFor(`document.querySelector('.missing-alert')?.textContent.includes('Cash-flow history & projection')`, 'the missing document first')
  const runId = await assess('TEST-DOS-022')
  await page.waitFor(`document.querySelector('.missing-doc')`, 'the missing document in the problems')
  await page.goto(engine.url + '/#/companies/TEST-DOS-022')
  await page.waitFor(`document.querySelector('.problems-panel .side-card-actions')`, 'the problems on the company page')
  await page.click('.problems-panel button', 'Draft request for all')
  await page.waitFor(`document.querySelector('dialog[open] button[type="submit"]')`, 'the draft dialog')
  await page.click('dialog[open] button[type="submit"]')
  await page.waitFor(`document.querySelectorAll('.request-list > li').length === 1`, 'the drafted request')
  await page.eval(`document.querySelector('.request-actions') || document.querySelector('.request-row').click()`)
  await page.waitFor(`document.querySelector('.request-actions button')`, 'the email editor')
  await page.click('.request-actions button', 'Send')
  await page.waitFor(`document.querySelector('.sent-confirm')`, 'sent', 10_000)
  assert.ok(runId)
  assert.deepEqual(page.errors, [])
})

test('a decline is explained, and a collateral shortfall turns eligible in the additional-collateral scenario', async () => {
  await assess('TEST-DOS-003')
  assert.match(await text('.run-verdict'), /^Not eligible/)
  const runId = await assess('TEST-DOS-004')
  assert.match(await text('.run-verdict'), /^Conditional/)
  await page.goto(engine.url + '/#/companies/TEST-DOS-004/assessment/' + runId)
  await page.waitFor(`document.querySelector('.flow-tabs')`, 'the assessment')
  await page.click('.flow-tabs [role="tab"]', 'Scenarios')
  await page.waitFor(`document.querySelectorAll('.scenario-option').length === 4`, 'the scenarios')
  const outcomes = await page.eval<string[]>(`[...document.querySelectorAll('.scenario-option')].map(o => o.querySelector('h3').textContent + ': ' + o.querySelector('.badge').textContent)`)
  assert.deepEqual(outcomes.slice(0, 2), ['Base application: Conditional', 'Additional collateral: Eligible'])
  assert.match(await text('.scenario-option .scenario-why'), /^Because: /)
  await page.click('.flow-tabs [role="tab"]', 'Decision')
  await page.waitFor(`document.querySelector('.decision-hero h2')?.textContent.startsWith('Conditional: not ready')`, 'the decision is not open to a conditional case')
  assert.deepEqual(page.errors, [])
})

test('an early warning on a credit client: banner, the assistant, the watchlist, a request for information and a freeze a colleague approves', async () => {
  await post('/monitoring/simulate', { companyId: 'TEST-DOS-061', kind: 'news-insolvency' })
  await post('/monitoring/check', { companyId: 'TEST-DOS-061' })
  await post('/companies/TEST-DOS-061/contacts', { name: 'Elena Marin', role: 'Chief financial officer', email: 'elena.marin@tarom.example.ro', phone: '' })
  await page.goto(engine.url + '/#/companies/TEST-DOS-061')
  await page.waitFor(`document.querySelector('.risk-banner.critical')`, 'the critical banner', 20_000)
  assert.match(await text('.risk-banner'), /1 critical signal on Tarom/)
  await page.click('.risk-banner button', 'Review with the assistant')
  await page.waitFor(`document.querySelector('.sa-note .sa-severity')?.textContent.startsWith('Critical')`, 'the risk note')
  assert.deepEqual(await page.eval(`[...document.querySelectorAll('.sa-actions strong')].map(s => s.textContent)`), ['Put on watchlist', 'Request information', 'Freeze drawdowns', 'Run a new assessment', 'Send to Legal'])
  await page.click('.sa-actions button', 'Put on watchlist')
  await page.waitFor(`document.querySelectorAll('dialog[open]').length === 2`, 'the watchlist dialog')
  await page.eval(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('button[type="submit"]').click()`)
  await page.waitFor(`document.querySelector('.sa-head .risk-chip')?.textContent.startsWith('Watchlist · red')`, 'on the watchlist')
  await page.click('.sa-actions button', 'Request information')
  await page.waitFor(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('.request-actions')`, 'the drafted request for information', 10_000)
  await page.eval(`[...[...document.querySelectorAll('dialog[open]')].at(-1).querySelectorAll('.request-actions button')].find(b => b.textContent.includes('Send')).click()`)
  await page.waitFor(`document.querySelectorAll('dialog[open]').length === 1`, 'the request sent and its dialog closed', 10_000)
  await page.click('.sa-actions button', 'Freeze drawdowns')
  await page.waitFor(`document.querySelectorAll('dialog[open]').length === 2`, 'the freeze dialog')
  await page.eval(`[...document.querySelectorAll('dialog[open]')].at(-1).querySelector('button[type="submit"]').click()`)
  await page.waitFor(`[...document.querySelectorAll('.sa-actions button')].some(b => b.textContent.includes('Waiting for approval'))`, 'the freeze waiting for approval')
  await page.screenshot(shots + '04-early-warning.png')
  await page.click('dialog[open] .dialog-header .icon-button')
  // A colleague approves it from the banner.
  await page.click('.sidebar .profile')
  // (The approval earlier switched the workspace to Cristina Dobre, who asked for the freeze; a third employee approves it.)
  await page.click('.user-menu-group button', 'Andrei Popa')
  await page.waitFor(`[...document.querySelectorAll('.risk-banner button')].some(b => b.textContent.includes('Approve freeze'))`, 'the freeze to approve')
  await page.click('.risk-banner button', 'Approve freeze')
  await page.waitFor(`document.querySelector('.risk-banner .risk-chip')?.textContent.includes('drawdowns frozen')`, 'drawdowns frozen')
  const log = await fetch(engine.url + '/api/activity?company=TEST-DOS-061').then(r => r.json())
  assert.deepEqual(log.filter((e: any) => /watchlist|freeze|information|Request sent/.test(e.action)).map((e: any) => e.action + ' · ' + e.actor), ['Client put on the watchlist (red) · Cristina Dobre', 'Request for information drafted · Cristina Dobre', 'Request sent (simulated) · Cristina Dobre', 'Drawdown freeze requested · Cristina Dobre', 'Drawdown freeze approved · Andrei Popa'])
  assert.deepEqual(page.errors, [])
})

test('Live monitoring, the crawler window and its reader, the audit trail, the policy, the queue and the search all open and work', async () => {
  await page.goto(engine.url + '/#/monitoring')
  await page.waitFor(`document.querySelector('.risk-banner.critical')`, 'the critical banner on Live monitoring')
  await page.type('.mon-toolbar input', 'tarom')
  await page.waitFor(`document.querySelectorAll('.mon-table tbody tr').length === 1`, 'the search')
  await page.goto(engine.url + '/#/companies/TEST-DOS-061')
  await page.waitFor(`document.querySelectorAll('.crawl-row').length >= 1`, 'the crawler window')
  await page.click('.crawl-row')
  await page.waitFor(`document.querySelector('.reader .signal-agent .sa-note')`, 'the reader with the assistant')
  await page.click('dialog[open] .dialog-header .icon-button')
  for (const [route, ready] of [['/audit', '.workspace-audit-event'], ['/policy', '.policy-field'], ['/queue', '.company-card'], ['/departments/finance', '.case-table tbody tr'], ['/clients', '.clients-table tbody tr']]) {
    await page.goto(engine.url + '/#' + route)
    await page.waitFor(`document.querySelector(${JSON.stringify(ready)})`, route)
  }
  await page.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))`)
  await page.waitFor(`document.querySelector('.command-search input')`, 'the search dialog')
  await page.type('.command-search input', 'remedia')
  await page.waitFor(`document.querySelector('.command-results button')?.textContent.includes('FARMACEUTICA REMEDIA')`, 'the search result')
  await page.screenshot(shots + '05-search.png')
  assert.deepEqual(page.errors, [])
})
