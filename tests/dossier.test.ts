import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { foldAll } from '../src/assessment.ts'
import type { DossierUpload } from '../src/assessment.ts'
import type { Portfolio } from '../src/types.ts'
import { Engine } from '../server/engine/engine.ts'
import { type StoredUpload, effectiveCompany, inspectUpload } from '../server/engine/dossier.ts'
import { Store } from '../server/store.ts'

process.env.CREDITDESK_ANAF = 'off'
const portfolio: Portfolio = JSON.parse(readFileSync(new URL('../public/data/portfolio.json', import.meta.url), 'utf8'))
const documents = new URL('../public/documents', import.meta.url).pathname
const sample = (name: string) => new URL('../samples/' + name, import.meta.url).pathname
const company = (id: string) => portfolio.companies.find(c => c.id === id)!
const dir = mkdtempSync(join(tmpdir(), 'creditdesk-dossier-'))
const store = new Store(join(dir, 'runs.sqlite'))
const engine = new Engine(store, documents, null)

function upload(companyId: string, kind: string, file: string): StoredUpload {
  const id = crypto.randomUUID()
  const path = join(dir, id + '.pdf')
  copyFileSync(file, path)
  return { id, companyId, kind, file: kind + '-test.pdf', originalName: file.split('/').at(-1)!, sha256: '', pages: 0, fields: 0, uploadedAt: new Date().toISOString(), uploadedBy: 'test', removedAt: null, replaces: false, path }
}
async function assess(companyId: string, uploads: StoredUpload[]) {
  for (const u of uploads) {
    const check = await inspectUpload(company(companyId), u.kind, u.path)
    assert.ok(check.ok, companyId + ' ' + u.kind + ': ' + (!check.ok && check.reason))
    u.pages = check.pdf.pages.length
    u.sha256 = check.pdf.sha256
  }
  const runId = engine.start(await effectiveCompany(company(companyId), uploads), portfolio.policy, uploads as DossierUpload[])
  while (engine.isActive(runId)) await new Promise(r => setTimeout(r, 5))
  return foldAll(runId, store.events(runId))
}

test('uploads are checked: right company, right document, readable fields', async () => {
  const cashflow = sample('withheld/TEST-DOS-002_AEROSTAR-SA_cashflow.pdf')
  assert.equal((await inspectUpload(company('TEST-DOS-002'), 'cashflow', cashflow)).ok, true)
  const wrongCompany = await inspectUpload(company('TEST-DOS-022'), 'cashflow', cashflow)
  assert.ok(!wrongCompany.ok && /belongs to dossier TEST-DOS-002/.test(wrongCompany.reason))
  const wrongKind = await inspectUpload(company('TEST-DOS-002'), 'situatii_2024', cashflow)
  assert.ok(!wrongKind.ok && /not the 2024 financial statements/.test(wrongKind.reason))
  const notPdf = join(dir, 'not.pdf')
  writeFileSync(notPdf, '%PDF-1.4 broken')
  assert.equal((await inspectUpload(company('TEST-DOS-002'), 'cashflow', notPdf)).ok, false)
})

test('adding the missing cash flow lets the re-examination conclude', async () => {
  const before = await assess('TEST-DOS-002', [])
  assert.equal(before.decision!.decision, 'DATE_INSUFICIENTE')
  const after = await assess('TEST-DOS-002', [upload('TEST-DOS-002', 'cashflow', sample('withheld/TEST-DOS-002_AEROSTAR-SA_cashflow.pdf'))])
  assert.equal(after.status, 'completed')
  assert.notEqual(after.decision!.decision, 'DATE_INSUFICIENTE')
  assert.deepEqual(after.decision!.observations.missingDocuments, [])
  assert.ok(!after.findings.some(f => f.missingDocument))
  assert.notEqual(Object.values(after.workers).flatMap(w => w.checks).find(c => c.id === 'FIN-01')!.state, 'missing')
  assert.ok(after.notes.some(n => n.title === 'Documents added by the analyst'))
})

test('both missing statements added: CONTED is assessed on its financials', async () => {
  const after = await assess('TEST-DOS-019', [
    upload('TEST-DOS-019', 'situatii_2024', sample('withheld/TEST-DOS-019_CONTED-SA_situatii_2024.pdf')),
    upload('TEST-DOS-019', 'situatii_2025', sample('withheld/TEST-DOS-019_CONTED-SA_situatii_2025.pdf')),
  ])
  assert.deepEqual(after.decision!.observations.missingDocuments, [])
  const checks = Object.values(after.workers).flatMap(w => w.checks)
  assert.ok(['FIN-03', 'FIN-04'].every(id => checks.find(c => c.id === id)!.state !== 'missing'))
})

test('a corrected application is reconciled against the recorded request and clears the conflict', async () => {
  const before = await assess('TEST-DOS-018', [])
  assert.ok(before.findings.some(f => f.title.startsWith('Requested amount conflicts')))
  const after = await assess('TEST-DOS-018', [upload('TEST-DOS-018', 'cerere_finantare', sample('corrected/TEST-DOS-018_CONPET-SA_cerere_finantare.pdf'))])
  assert.ok(!after.findings.some(f => f.title.startsWith('Requested amount conflicts')))
  assert.equal(after.decision!.observations.discrepancies.length, 0)
  assert.notEqual(after.decision!.decision, 'DATE_INSUFICIENTE')
  // Replacing it with the original, conflicting application is caught again: the recorded data is kept.
  const again = await assess('TEST-DOS-018', [upload('TEST-DOS-018', 'cerere_finantare', join(documents, 'TEST-DOS-018/cerere_finantare.pdf'))])
  assert.ok(again.findings.some(f => f.title.startsWith('Requested amount conflicts')))
})
