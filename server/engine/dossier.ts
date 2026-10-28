/**
 * Documents an analyst adds to a dossier after intake. The original dataset
 * is never modified: uploads are stored beside the run database and laid
 * over the dataset's dossier to give the documents a run reviews.
 *
 * - A document that was missing has no recorded data, so its printed fields
 *   become the recorded data (the reconciliation has nothing to compare).
 * - A document that replaces one already in the dossier keeps the bank's
 *   recorded data, and the reconciliation compares the new PDF against it.
 */

import { basename, join } from 'node:path'
import type { DossierUpload } from '../../src/assessment.ts'
import { docNames } from '../../src/documents.ts'
import type { Company, Row } from '../../src/types.ts'
import type { PdfDocument } from './pdf.ts'
import { printedValue, readPdf } from './pdf.ts'
import { SOURCE_TABLES } from './reconcile.ts'

export interface StoredUpload extends DossierUpload { path: string }

/** Where a dossier document's file is on disk. */
export function documentFile(documentsDir: string, company: Company, doc: Row): string {
  return doc.localPath ?? join(documentsDir, company.id, basename(doc.fisier))
}

const name = (kind: string) => docNames[kind] ?? kind

/** Check that a PDF is the stated document of this company before it is accepted. */
export async function inspectUpload(company: Company, kind: string, file: string): Promise<{ ok: true; pdf: PdfDocument; fields: number } | { ok: false; reason: string }> {
  let pdf: PdfDocument
  try { pdf = await readPdf(file) } catch { return { ok: false, reason: 'The file is not a readable PDF.' } }
  const text = pdf.pages.slice(0, 1).flatMap(p => p.lines.map(l => l.text)).join('\n')
  const header = /Dosar: (TEST-DOS-\d+) \| Document: TEST-DOC-\d+-([A-Z0-9_]+)/.exec(text)
  const cui = /\| CUI (\d+)/.exec(text)?.[1]
  if (!header) return { ok: false, reason: 'CreditDesk could not confirm which dossier and document this is: the PDF does not carry the dossier header. Add documents in the dossier format.' }
  const [, dossier, printedKind] = header
  if (dossier !== company.id) return { ok: false, reason: 'This document belongs to dossier ' + dossier + ', not to ' + company.name + ' (' + company.id + ').' }
  if (cui && cui !== String(company.cui)) return { ok: false, reason: 'The document is for CUI ' + cui + '; ' + company.name + ' has CUI ' + company.cui + '.' }
  if (printedKind.toLowerCase() !== kind) return { ok: false, reason: 'This is the ' + name(printedKind.toLowerCase()) + ', not the ' + name(kind) + '.' }
  const fields = pdf.records.reduce((n, r) => n + Object.keys(r.fields).length, 0)
  if (SOURCE_TABLES[kind] && !fields) return { ok: false, reason: 'No fields could be read from the ' + name(kind) + '.' }
  return { ok: true, pdf, fields }
}

/** The printed records of a document as table rows, typed like the recorded data. */
function rowsFrom(pdf: PdfDocument, kind: string, documentId: string, company: Company): Row[] {
  const single = SOURCE_TABLES[kind]?.single
  const records = single ? pdf.records.filter(r => r.position === null).slice(0, 1) : pdf.records.filter(r => r.position !== null)
  return records.map((r, i) => ({
    record_id: documentId + '-' + String(i + 1).padStart(4, '0'), dosar_id: company.id, ...(single ? {} : { document_id: documentId }),
    ...Object.fromEntries(Object.entries(r.fields).map(([key, f]) => [key, printedValue(f.raw)])),
  }))
}

/** The dossier a run reviews: the dataset's documents with the analyst's uploads laid over them. */
export async function effectiveCompany(company: Company, uploads: StoredUpload[]): Promise<Company> {
  if (!uploads.length) return company
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(company.tables).map(([k, rows]) => [k, rows.map(r => ({ ...r }))]))
  // The latest upload of each kind wins.
  const latest = new Map<string, StoredUpload>()
  for (const u of [...uploads].sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt))) latest.set(u.kind, u)
  for (const u of latest.values()) {
    const documentId = 'UPLOAD-' + company.id.slice(5) + '-' + u.kind.toUpperCase() + '-' + u.id.slice(0, 8)
    const previous = tables.documente.find(d => d.tip_document === u.kind)
    tables.documente = tables.documente.filter(d => d.tip_document !== u.kind)
    const source = SOURCE_TABLES[u.kind]
    let mode: 'compared' | 'ingested' | 'text' = 'text'
    if (source) {
      const expectedId = previous?.document_id ?? company.id.replace('TEST-DOS-', 'TEST-DOC-') + '-' + u.kind.toUpperCase()
      const rows = tables[source.table] ?? []
      const recorded = source.single ? rows : source.allRows ? rows : rows.filter(r => r.document_id === expectedId)
      if (recorded.length) {
        mode = 'compared'
        if (!source.single && !source.allRows) for (const r of recorded) r.document_id = documentId
      } else {
        mode = 'ingested'
        tables[source.table] = [...rows, ...rowsFrom(await readPdf(u.path), u.kind, documentId, company)]
      }
    }
    tables.documente.push({
      record_id: documentId, dosar_id: company.id, document_id: documentId, tip_document: u.kind, fisier: 'uploads/' + company.id + '/' + u.file,
      mime_type: 'application/pdf', sha256: u.sha256, cui: company.cui, emitent: 'Added by ' + u.uploadedBy, data_emitere: u.uploadedAt.slice(0, 10),
      pagini: u.pages, localPath: u.path, supplied: { uploadId: u.id, by: u.uploadedBy, at: u.uploadedAt, originalName: u.originalName, replaces: Boolean(previous), mode },
    })
  }
  return { ...company, tables }
}
