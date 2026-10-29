// Captures every page of the built workspace for visual review, against an
// isolated engine (own data folder, no model, no ANAF call) with a few runs.
//
//   npm run screenshots [-- out-dir] [width] [height]
import { launch } from '../tests/support/browser.ts'
import { readStream, startEngine } from '../tests/support/engine.ts'

const out = (process.argv[2] ?? new URL('../test-results/screens/', import.meta.url).pathname).replace(/\/?$/, '/')
const width = Number(process.argv[3] ?? 1440)
const height = Number(process.argv[4] ?? 900)
const ASSESS = ['TEST-DOS-018', 'TEST-DOS-002', 'TEST-DOS-015', 'TEST-DOS-006']

const engine = await startEngine({ CREDITDESK_LLM: 'none', CREDITDESK_ANAF: 'off', CREDITDESK_ONBOARD: 'on' })
const page = await launch(width, height)
try {
  const runs: Record<string, string> = {}
  for (const id of ASSESS) {
    runs[id] = (await engine.post('/companies/' + id + '/runs')).runId
    await readStream(engine.url + '/api/runs/' + runs[id] + '/stream?after=0')
  }
  // Some people-side content: a case sent to Finance, a contact, a drafted request.
  const events = await engine.get('/runs/' + runs['TEST-DOS-018'])
  const finding = events.events.find((e: any) => e.type === 'finding_raised').payload.finding
  const opened = await engine.post('/cases', { companyId: 'TEST-DOS-018', runId: runs['TEST-DOS-018'], findingId: finding.id, department: 'finance', note: 'Please confirm which amount is right before we go further.' })
  await engine.post('/companies/TEST-DOS-018/contacts', { name: 'Maria Enache', role: 'Chief financial officer', email: 'maria.enache@conpet.example.ro', phone: '+40 244 401 360' })
  await engine.post('/cases/' + opened.case.id + '/request', { language: 'en' })
  await engine.post('/companies/TEST-DOS-018/suggestions')
  // A credit client, assessed and checked by monitoring.
  const client = (await engine.post('/companies/TEST-DOS-053/runs')).runId
  await readStream(engine.url + '/api/runs/' + client + '/stream?after=0')
  await engine.post('/monitoring/check', { companyId: 'TEST-DOS-053' })
  await new Promise(r => setTimeout(r, 1500))
  // A rehearsal: test signals planted for the client and found by its next check.
  for (const kind of ['news-insolvency', 'register-inactive']) await engine.post('/monitoring/simulate', { companyId: 'TEST-DOS-053', kind })
  await engine.post('/monitoring/check', { companyId: 'TEST-DOS-053' })
  await new Promise(r => setTimeout(r, 1500))
  const shots: [string, string, string?][] = [
    ['overview', '/overview'], ['directory', '/companies'], ['queue', '/queue'], ['audit', '/audit'], ['policy', '/policy'],
    ['departments', '/departments/finance'], ['case', '/cases/' + opened.case.id],
    ['clients', '/clients'], ['monitoring', '/monitoring'], ['client', '/companies/TEST-DOS-053'],
    ['entry-assessed', '/companies/TEST-DOS-018'], ['entry-new', '/companies/TEST-DOS-001'], ['entry-missing', '/companies/TEST-DOS-002'],
    ['run', '/companies/TEST-DOS-018/run/' + runs['TEST-DOS-018']],
    ['assessment', '/companies/TEST-DOS-018/assessment/' + runs['TEST-DOS-018']],
    ['assessment-missing', '/companies/TEST-DOS-002/assessment/' + runs['TEST-DOS-002']],
    ['assessment-ledger', '/companies/TEST-DOS-015/assessment/' + runs['TEST-DOS-015']],
    ['assessment-clear', '/companies/TEST-DOS-053/assessment/' + client],
  ]
  await page.goto(engine.url + '/')
  for (const [name, route] of shots) {
    await page.eval(`location.hash = ${JSON.stringify(route)}`)
    await new Promise(r => setTimeout(r, 1200))
    await page.screenshot(out + name + '.png')
    await page.screenshot(out + name + '-full.png', true)
    // The problems to solve, next to the evidence.
    if (await page.eval(`[...document.querySelectorAll('.ws-tabs [role="tab"]')].some(t => t.textContent.startsWith('Problems'))`)) {
      await page.eval(`[...document.querySelectorAll('.ws-tabs [role="tab"]')].find(t => t.textContent.startsWith('Problems')).click()`)
      await new Promise(r => setTimeout(r, 500))
      await page.screenshot(out + name + '-problems.png')
    }
    // Every tab of a page with tabs.
    const tabs = await page.eval<string[]>(`[...document.querySelectorAll('.flow-tabs [role="tab"]')].map(t => t.textContent.trim())`)
    for (const [i, tab] of tabs.entries()) {
      if (i === 0) continue
      await page.eval(`document.querySelectorAll('.flow-tabs [role="tab"]')[${i}].click()`)
      await new Promise(r => setTimeout(r, 600))
      await page.screenshot(out + name + '-tab-' + tab.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.png', true)
    }
  }
  console.log('Screenshots in ' + out + (page.errors.length ? '\nPage errors:\n' + page.errors.join('\n') : ''))
} finally {
  await page.close()
  await engine.stop()
}
