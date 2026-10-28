/**
 * Original-document access for the workers. Text and word coordinates come
 * from Poppler's `pdftotext -bbox-layout`; page images from `pdftoppm`. Both
 * use PDF points with a top-left origin, so a box found here outlines the
 * same spot on the rendered page.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Box } from '../../src/assessment.ts'

const run = promisify(execFile)

export interface PdfWord { text: string; box: Box }
export interface PdfLine { text: string; box: Box; words: PdfWord[] }
export interface PdfPage { number: number; width: number; height: number; lines: PdfLine[] }

export interface PdfField {
  key: string
  raw: string
  page: number
  /** The printed value only, without its label. */
  valueBox: Box
  /** Label and value together. */
  lineBox: Box
  /** The value continued onto following lines, so its printed spacing is not meaningful. */
  wrapped: boolean
}
export interface PdfRecord {
  /** `--- Pozitia N ---`; null for single-record documents. */
  position: number | null
  page: number
  fields: Record<string, PdfField>
}
export interface PdfDocument {
  file: string
  sha256: string
  pages: PdfPage[]
  records: PdfRecord[]
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : entities[e] ?? m)
const attr = (tag: string, name: string) => Number(new RegExp(name + '="([^"]+)"').exec(tag)?.[1] ?? 0)
const boxOf = (tag: string): Box => ({ x0: attr(tag, 'xMin'), y0: attr(tag, 'yMin'), x1: attr(tag, 'xMax'), y1: attr(tag, 'yMax') })

export function union(boxes: Box[]): Box {
  return {
    x0: Math.min(...boxes.map(b => b.x0)), y0: Math.min(...boxes.map(b => b.y0)),
    x1: Math.max(...boxes.map(b => b.x1)), y1: Math.max(...boxes.map(b => b.y1)),
  }
}

export function parseBboxLayout(xml: string): PdfPage[] {
  const pages: PdfPage[] = []
  const pageRe = /<page ([^>]*)>([\s\S]*?)<\/page>/g
  for (let m = pageRe.exec(xml); m; m = pageRe.exec(xml)) {
    const lines: PdfLine[] = []
    const lineRe = /<line ([^>]*)>([\s\S]*?)<\/line>/g
    for (let l = lineRe.exec(m[2]); l; l = lineRe.exec(m[2])) {
      const words: PdfWord[] = []
      const wordRe = /<word ([^>]*)>([\s\S]*?)<\/word>/g
      for (let w = wordRe.exec(l[2]); w; w = wordRe.exec(l[2])) words.push({ text: decode(w[2]), box: boxOf(w[1]) })
      if (words.length) lines.push({ text: words.map(w => w.text).join(' '), box: boxOf(l[1]), words })
    }
    pages.push({ number: pages.length + 1, width: attr(m[1], 'width'), height: attr(m[1], 'height'), lines })
  }
  return pages
}

// Printed on every page by the dossier generator; never part of a record.
const boilerplate = /^(DEMO \| pagina|SIMULAT \/ HACKATHON|TEST-DOS-\d+ \||Dosar: |Identitate publica|CUI public:|Toate datele|Emitent:|Data referinta:|[A-Z0-9 ]+ \/ DEMO$)/
const key = /^([a-z][A-Za-z0-9_]*):$/

/** Group `key: value` lines into the document's records. */
export function parseRecords(pages: PdfPage[]): PdfRecord[] {
  const records: PdfRecord[] = []
  let current: PdfRecord | null = null
  let last: PdfField | null = null
  // Where the last consumed line of `last` ended.
  let tail = { page: 0, y1: 0 }
  for (const page of pages) {
    let firstOnPage = true
    for (const line of page.lines) {
      if (boilerplate.test(line.text)) continue
      const continuesFromPreviousPage = firstOnPage && last !== null && tail.page === page.number - 1
      firstOnPage = false
      const position = /^--- Pozitia (\d+) ---$/.exec(line.text)
      if (position) {
        current = { position: Number(position[1]), page: page.number, fields: {} }
        records.push(current)
        last = null
        continue
      }
      const label = key.exec(line.words[0].text)
      if (label && line.words.length > 1) {
        if (!current) { current = { position: null, page: page.number, fields: {} }; records.push(current) }
        const valueWords = line.words.slice(1)
        last = {
          key: label[1], raw: valueWords.map(w => w.text).join(' '), page: page.number,
          valueBox: union(valueWords.map(w => w.box)), lineBox: line.box, wrapped: false,
        }
        current.fields[label[1]] = last
        tail = { page: page.number, y1: line.box.y1 }
      } else if (last && (continuesFromPreviousPage || (tail.page === page.number && line.box.y0 - tail.y1 < 6))) {
        // A long value wrapped onto the next line (possibly the next page).
        last.raw += ' ' + line.text
        last.wrapped = true
        if (last.page === page.number) {
          last.valueBox = union([last.valueBox, line.box])
          last.lineBox = union([last.lineBox, line.box])
        }
        tail = { page: page.number, y1: line.box.y1 }
      } else {
        last = null
      }
    }
  }
  return records
}

const cache = new Map<string, Promise<PdfDocument>>()

export function readPdf(file: string): Promise<PdfDocument> {
  let pending = cache.get(file)
  if (!pending) {
    pending = (async () => {
      const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex')
      const { stdout } = await run('pdftotext', ['-bbox-layout', file, '-'], { maxBuffer: 16 * 1024 * 1024 })
      const pages = parseBboxLayout(stdout)
      return { file, sha256, pages, records: parseRecords(pages) }
    })()
    pending.catch(() => cache.delete(file))
    cache.set(file, pending)
  }
  return pending
}

/** Typed value of a printed field, in the conventions of the source tables. */
export function printedValue(raw: string, like?: unknown): unknown {
  if (typeof like === 'string') return raw.trim()
  const text = raw.trim()
  if (text === 'NECUNOSCUT / neaplicabil') return null
  if (text === 'da') return true
  if (text === 'nu') return false
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if (/^[[{]/.test(text)) { try { return JSON.parse(text) } catch { return text } }
  return text
}

/** Lines on a page whose text contains the quote (whitespace-insensitive). */
export function findQuote(doc: PdfDocument, quote: string, page?: number): { page: number; box: Box } | null {
  const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const needle = squash(quote)
  if (needle.length < 4) return null
  // A quote may span consecutive lines; the smallest run of lines that contains it wins.
  for (let size = 1; size <= 6; size++) {
    for (const p of doc.pages) {
      if (page && p.number !== page) continue
      for (let i = 0; i + size <= p.lines.length; i++) {
        const text = p.lines.slice(i, i + size).map(l => squash(l.text)).join('')
        if (text.includes(needle)) return { page: p.number, box: union(p.lines.slice(i, i + size).map(l => l.box)) }
      }
    }
  }
  return null
}

export function pageText(doc: PdfDocument, page: number): string {
  return doc.pages[page - 1]?.lines.map(l => l.text).join('\n') ?? ''
}

/** Render one page to PNG once, at 2× (144 dpi). */
export async function renderPage(file: string, sha256: string, page: number, cacheDir: string): Promise<string> {
  mkdirSync(cacheDir, { recursive: true })
  const prefix = join(cacheDir, sha256.slice(0, 32) + '-' + page)
  const target = prefix + '.png'
  if (!existsSync(target)) await run('pdftoppm', ['-r', '144', '-png', '-f', String(page), '-l', String(page), '-singlefile', file, prefix])
  return target
}
