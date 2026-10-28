/**
 * Field-level comparison of the original PDFs with the bank's recorded data.
 * Pure: the workers call it, the tests call it, and nothing here reads the
 * dataset's quality labels (`calitate_date`) or document `probleme` notes.
 */

import type { Row } from '../../src/types.ts'
import type { PdfDocument, PdfField, PdfRecord } from './pdf.ts'
import { printedValue } from './pdf.ts'

/** Recorded table that each original document is the source of. */
export const SOURCE_TABLES: Record<string, { table: string; single?: boolean; allRows?: boolean; label: string }> = {
  cerere_finantare: { table: 'solicitari', single: true, label: 'solicitare' },
  identificare_kyc_demo: { table: 'companii', single: true, label: 'companie' },
  balanta: { table: 'balanta', label: 'balanta' },
  cashflow: { table: 'cashflow', label: 'cashflow' },
  situatii_2024: { table: 'situatii_financiare', label: 'situatii_financiare' },
  situatii_2025: { table: 'situatii_financiare', label: 'situatii_financiare' },
  creante_datorii_comerciale: { table: 'creante_datorii_comerciale', label: 'creante_datorii_comerciale' },
  credite_leasing: { table: 'credite_leasing', label: 'credite_leasing' },
  serviciu_datorie: { table: 'serviciu_datorie', label: 'serviciu_datorie' },
  garantii: { table: 'garantii', label: 'garantii' },
  garanti: { table: 'garanti', label: 'garanti' },
  crc_demo: { table: 'verificari_credit', label: 'verificari_credit' },
  cip_demo: { table: 'verificari_credit', label: 'verificari_credit' },
  situatie_fiscala: { table: 'situatie_fiscala', label: 'situatie_fiscala' },
  // Litigation rows reference their source register, not the PDF.
  litigii_demo: { table: 'litigii', label: 'litigii', allRows: true },
}

/** Bookkeeping columns that exist only in the recorded tables. */
const IGNORED = new Set(['record_id', 'dosar_id', 'document_id', 'pagina_sau_foaie', 'rand_sursa'])

export interface FieldMismatch {
  kind: string
  documentId: string
  field: string
  table: string
  rowIndex: number
  position: number | null
  printed: unknown
  recorded: unknown
  pdf: PdfField
}

const squash = (s: string) => s.replace(/\s+/g, '')

/**
 * Printed and recorded values agree. Numbers compare numerically; when the
 * printed value wrapped across lines, the spacing inside its text does not
 * count (the PDF breaks long values mid-word).
 */
export function sameValue(printed: unknown, recorded: unknown, wrapped = false): boolean {
  if (typeof recorded === 'number') return typeof printed === 'number' && Math.abs(recorded - printed) < 0.005
  if (recorded === null || recorded === undefined) return printed === null
  if (typeof recorded === 'string') return typeof printed === 'string' && (wrapped ? squash(printed) === squash(recorded) : printed === recorded)
  if (typeof recorded === 'boolean') return printed === recorded
  if (Array.isArray(recorded)) return Array.isArray(printed) && printed.length === recorded.length && recorded.every((v, i) => sameValue(printed[i], v, wrapped))
  if (typeof recorded === 'object') {
    if (!printed || typeof printed !== 'object' || Array.isArray(printed)) return false
    const a = printed as Record<string, unknown>, b = recorded as Record<string, unknown>
    return Object.keys(a).length === Object.keys(b).length && Object.keys(b).every(k => k in a && sameValue(a[k], b[k], wrapped))
  }
  return String(printed) === String(recorded)
}

/** The recorded rows that came from this document, in printed order. */
export function sourceRows(tables: Record<string, Row[]>, kind: string, documentId: string): Row[] {
  const source = SOURCE_TABLES[kind]
  if (!source) return []
  const rows = tables[source.table] ?? []
  return source.single ? rows.slice(0, 1) : source.allRows ? rows : rows.filter(r => r.document_id === documentId)
}

export function recordFor(pdf: PdfDocument, kind: string, index: number): PdfRecord | undefined {
  return SOURCE_TABLES[kind]?.single ? pdf.records.find(r => r.position === null) : pdf.records.find(r => r.position === index + 1)
}

export function compareDocument(tables: Record<string, Row[]>, kind: string, documentId: string, pdf: PdfDocument): { compared: number; mismatches: FieldMismatch[]; unmatchedRecords: number } {
  const source = SOURCE_TABLES[kind]
  const rows = sourceRows(tables, kind, documentId)
  const mismatches: FieldMismatch[] = []
  let compared = 0
  rows.forEach((row, index) => {
    const record = recordFor(pdf, kind, index)
    if (!record) return
    for (const [field, recorded] of Object.entries(row)) {
      if (IGNORED.has(field)) continue
      const printed = record.fields[field]
      if (!printed) continue
      compared++
      const value = printedValue(printed.raw, recorded)
      if (!sameValue(value, recorded, printed.wrapped)) mismatches.push({ kind, documentId, field, table: source.table, rowIndex: index, position: record.position, printed: value, recorded, pdf: printed })
    }
  })
  const positions = pdf.records.filter(r => r.position !== null).length
  return { compared, mismatches, unmatchedRecords: source?.single ? 0 : Math.abs(positions - rows.length) }
}

export interface LedgerIssue {
  kind: 'unbalanced_account' | 'unbalanced_totals' | 'duplicate_account' | 'mixed_units'
  account?: string
  detail: string
  /** Row indexes of the recorded ledger involved. */
  rows: number[]
  fields: string[]
  amount?: number
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

/** Arithmetic checks on the trial balance itself. */
export function ledgerIssues(balance: Row[]): { issues: LedgerIssue[]; totals: Record<string, number>; accounts: number } {
  const included = balance.map((row, index) => ({ row, index })).filter(x => x.row.include_in_total)
  const issues: LedgerIssue[] = []
  for (const { row, index } of included) {
    const opening = row.sold_initial_debit - row.sold_initial_credit
    const closing = row.sold_final_debit - row.sold_final_credit
    const expected = r2(opening + row.rulaj_perioada_debit - row.rulaj_perioada_credit)
    const gap = r2(closing - expected)
    if (Math.abs(gap) > 0.02) issues.push({
      kind: 'unbalanced_account', account: String(row.cod_cont), rows: [index], amount: gap,
      fields: ['sold_initial_debit', 'sold_initial_credit', 'rulaj_perioada_debit', 'rulaj_perioada_credit', 'sold_final_debit', 'sold_final_credit'],
      detail: 'Account ' + row.cod_cont + ': opening ' + opening + ' + debit movements ' + row.rulaj_perioada_debit + ' − credit movements ' + row.rulaj_perioada_credit + ' = ' + expected + ', but the closing balance is ' + r2(closing) + ' (difference ' + gap + ').',
    })
  }
  const totals: Record<string, number> = {}
  for (const key of ['sold_initial_debit', 'sold_initial_credit', 'rulaj_perioada_debit', 'rulaj_perioada_credit', 'sold_final_debit', 'sold_final_credit'])
    totals[key] = r2(included.reduce((s, x) => s + x.row[key] * x.row.unitate, 0))
  for (const [d, c, label] of [['sold_initial_debit', 'sold_initial_credit', 'Opening'], ['rulaj_perioada_debit', 'rulaj_perioada_credit', 'Period movement'], ['sold_final_debit', 'sold_final_credit', 'Closing']]) {
    const gap = r2(totals[d] - totals[c])
    if (Math.abs(gap) > 0.025) issues.push({ kind: 'unbalanced_totals', rows: [], fields: [d, c], amount: gap, detail: label + ' totals: debit ' + totals[d] + ' vs credit ' + totals[c] + ' (difference ' + gap + ').' })
  }
  const seen = new Map<string, number[]>()
  for (const { row, index } of included) seen.set(String(row.cod_cont), [...(seen.get(String(row.cod_cont)) ?? []), index])
  for (const [account, rows] of seen) if (rows.length > 1) issues.push({
    kind: 'duplicate_account', account, rows, fields: ['cod_cont'],
    detail: 'Account ' + account + ' is included in the totals ' + rows.length + ' times (positions ' + rows.map(i => i + 1).join(', ') + ').',
  })
  const units = new Map<number, number[]>()
  for (const { row, index } of included) units.set(row.unitate, [...(units.get(row.unitate) ?? []), index])
  if (units.size > 1) {
    const [common] = [...units.entries()].sort((a, b) => b[1].length - a[1].length)
    for (const [unit, rows] of units) if (unit !== common[0]) issues.push({
      kind: 'mixed_units', rows, fields: ['unitate'],
      detail: rows.length + ' ledger row(s) declare unit ' + unit + ' while ' + common[1].length + ' rows declare unit ' + common[0] + '.',
    })
  }
  return { issues, totals, accounts: included.length }
}
