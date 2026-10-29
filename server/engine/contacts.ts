/**
 * Finding a company's public contact. The assistant searches the public web
 * (Codex with web search) for an official address and the page it is printed
 * on; the engine then opens that page itself and only marks the contact
 * verified when the address really appears there. The ANAF register adds the
 * official phone number. Nothing is guessed: no find, no contact.
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Company } from '../../src/types.ts'
import { undeliverable } from '../../src/workspace.ts'
import type { CodexConfig } from './codex.ts'
import { askCodex } from './codex.ts'

export const USER_AGENT = 'Finra/1.0 (corporate lending review; public pages only)'

export interface FoundContact {
  email: string
  phone: string
  website: string
  sourceUrl: string
  quote: string
  /** The engine found the address printed on the source page. */
  verified: boolean
  author: string
  reason: string
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['email', 'phone', 'website', 'source_url', 'quote'],
  properties: { email: { type: 'string' }, phone: { type: 'string' }, website: { type: 'string' }, source_url: { type: 'string' }, quote: { type: 'string' } },
}

const pdfText = (file: string) => new Promise<string>(resolve => execFile('pdftotext', ['-layout', file, '-'], { maxBuffer: 32 * 1024 * 1024, timeout: 20_000 }, (err, out) => resolve(err ? '' : out)))

/** A public page as text: HTML without markup, or a PDF through pdftotext. Empty when it cannot be read. */
export async function pageText(url: string, signal?: AbortSignal): Promise<{ text: string; type: string; status: number; bytes: Buffer | null }> {
  try {
    if (!/^https?:\/\//i.test(url)) return { text: '', type: '', status: 0, bytes: null }
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/pdf;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000) })
    const type = res.headers.get('content-type') ?? ''
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > 12 * 1024 * 1024) return { text: '', type, status: res.status, bytes: null }
    if (type.includes('pdf') || bytes.subarray(0, 5).toString() === '%PDF-') {
      const dir = mkdtempSync(join(tmpdir(), 'creditdesk-page-'))
      try { writeFileSync(join(dir, 'p.pdf'), bytes); return { text: await pdfText(join(dir, 'p.pdf')), type: 'application/pdf', status: res.status, bytes } }
      finally { rmSync(dir, { recursive: true, force: true }) }
    }
    const html = bytes.toString('utf8')
    const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#64;|&commat;/g, '@').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ')
    return { text, type, status: res.status, bytes }
  } catch { return { text: '', type: '', status: 0, bytes: null } }
}

export async function findContact(company: Company, codex: CodexConfig | null, signal: AbortSignal): Promise<FoundContact | null> {
  if (!codex) return null
  const prompt = [
    'Find the official public contact email of ' + company.name + ', Romania, CUI ' + company.cui + (company.symbol ? ', listed on the Bucharest Stock Exchange as ' + company.symbol : '') + '.',
    'Prefer the investor-relations or general office address published by the company itself (its website, its stock-exchange reports). Do not use personal addresses, directories that hide the address, or guesses.',
    'Search the web. Return the email, the company phone, the official website, the URL of the page where the email is printed, and the exact text from that page that contains the email. Use "" for anything you did not find on a page.',
  ].join('\n')
  const answer = await askCodex<{ email: string; phone: string; website: string; source_url: string; quote: string }>(codex, prompt, SCHEMA, signal, { webSearch: true })
  const author = 'Codex ' + codex.model + ' · web search'
  if (!answer.ok || !answer.value) return { email: '', phone: '', website: '', sourceUrl: '', quote: '', verified: false, author, reason: answer.reason }
  const v = answer.value
  const email = v.email.trim().toLowerCase()
  if (!email || undeliverable(email)) return { email: '', phone: v.phone, website: v.website, sourceUrl: v.source_url, quote: v.quote, verified: false, author, reason: 'no address found' }
  // The engine reads the page itself: the address must be printed there.
  const page = await pageText(v.source_url, signal)
  const verified = page.text.toLowerCase().includes(email)
  return { email, phone: v.phone.trim(), website: v.website.trim(), sourceUrl: v.source_url, quote: v.quote, verified, author, reason: verified ? 'found on the page' : page.text ? 'not printed on the page the model gave' : 'the page could not be opened' }
}
