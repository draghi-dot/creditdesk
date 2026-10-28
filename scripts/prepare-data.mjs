import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, '../raiffeisen_50_companii')
const dataRoot = resolve(source, 'dataset')
const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
const tables = read(resolve(dataRoot, 'toate_tabelele.json'))
const directory = read(resolve(dataRoot, 'index_companii_50.json'))
const csv = readFileSync(resolve(source, 'companii_surse.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map(line => line.split(','))
const sectorLabels = {
 'echipamente industriale':'Industrial equipment','industria aeronautica':'Aerospace','metalurgie':'Metallurgy',
 'materiale constructii':'Building materials','farmaceutice':'Pharmaceuticals','distributie si logistica':'Distribution & logistics',
 'software':'Software & technology','produse din cauciuc':'Industrial manufacturing','industria bauturilor':'Food & beverage',
 'servicii IT':'IT services','materiale abrazive':'Industrial manufacturing','turism':'Hospitality',
 'constructii':'Construction','componente auto':'Automotive','servicii industriale':'Industrial services',
 'transport produse petroliere':'Energy infrastructure','confectii':'Textiles','echipamente electrice':'Electrical equipment',
 'distributie farmaceutica':'Pharmaceutical distribution','dezvoltare imobiliara':'Real estate',
 'utilaje agricole':'Agricultural equipment','servicii medicale':'Healthcare','logistica petroliera':'Energy logistics',
 'energie si petrol':'Energy & oil','ambalaje':'Packaging','materiale plastice':'Manufacturing','rafinare':'Energy & refining',
 'servicii petroliere':'Energy services','energie':'Energy & utilities','gaze naturale':'Natural gas',
 'transport gaze naturale':'Energy infrastructure','energie regenerabila':'Renewable energy','securitate cibernetica':'Cybersecurity',
 'constructii navale':'Shipbuilding','industrie chimica':'Chemicals','logistica portuara':'Port logistics',
 'restaurante':'Food & hospitality','hartie si carton':'Paper & packaging',
}
const companies = directory.map((entry, i) => {
 const companyTables = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.filter(r => r.dosar_id === entry.dosar_id)]))
 for (const doc of companyTables.documente) {
  const filename = doc.fisier.split('/').at(-1)
  const target = resolve(root, 'public/documents', entry.dosar_id, filename)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(resolve(dataRoot, doc.fisier), target)
 }
 return {
  id: entry.dosar_id, symbol: entry.simbol, name: entry.denumire, cui: entry.cui,
  sector: sectorLabels[csv[i][3]] || csv[i][3], city: csv[i][5],
  tables: companyTables,
 }
})
// The dataset's policy under the workspace's own name; thresholds and rules are unchanged.
function workspacePolicy(policy) {
 const id = rule => rule.replace(/^DEMO-/, 'POL-')
 return {
  ...policy, politica_id: 'POL-CL-2026', versiune: '1.0', aprobata_de: 'Credit committee',
  criterii_eliminatorii: policy.criterii_eliminatorii.map(c => ({ ...c, regula_id: id(c.regula_id) })),
  exceptii_permise: policy.exceptii_permise.map(e => ({ ...e, regula_id: id(e.regula_id), aprobare_necesara: e.aprobare_necesara.replace(/_DEMO$/, '') })),
  tratament_litigii: String(policy.tratament_litigii).replace(/^DEMO:\s*/, ''),
 }
}
mkdirSync(resolve(root, 'public/data'), { recursive: true })
writeFileSync(resolve(root, 'public/data/portfolio.json'), JSON.stringify({
 companies, policy: workspacePolicy(read(resolve(dataRoot, 'politica_demo.json'))),
 metadata: { financialDate: '2026-09-30', analysisDate: '2026-10-28', synthetic: true, source: '50-company hackathon dataset' },
}))
console.log('Prepared 50 company dossiers and 792 PDF documents. No expected outcomes included in UI data.')
