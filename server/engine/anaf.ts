/**
 * Live lookup in ANAF's public taxpayer register (PlatitorTvaRest v9). This is
 * a real network call against the public service; the dossier's own company
 * profile is synthetic, so only the real identity fields are compared.
 */

export interface AnafRecord {
  cui: number
  name: string
  address: string
  registrationStatus: string
  registeredOn: string
  tradeRegister: string
  caen: string
  legalForm: string
  vatPayer: boolean
  inactive: boolean
  eInvoice: boolean
  queriedAt: string
  endpoint: string
}

export const ANAF_ENDPOINT = 'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva'

export async function lookupAnaf(cui: string, date: string, signal: AbortSignal, timeoutMs = 10_000): Promise<{ found: AnafRecord | null; error: string | null; durationMs: number }> {
  const started = Date.now()
  if (process.env.CREDITDESK_ANAF === 'off') return { found: null, error: 'ANAF lookup disabled (CREDITDESK_ANAF=off)', durationMs: 0 }
  const timeout = AbortSignal.timeout(timeoutMs)
  try {
    const res = await fetch(ANAF_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ cui: Number(cui), data: date }]),
      signal: AbortSignal.any([signal, timeout]),
    })
    const body = await res.json().catch(() => null) as { found?: any[]; notFound?: unknown[] } | null
    // When none of the requested CUIs is registered, ANAF answers 404 and lists them in notFound.
    if (!body || (!res.ok && !(res.status === 404 && body.notFound?.length))) return { found: null, error: 'ANAF answered HTTP ' + res.status + (body ? '' : ' without a readable answer'), durationMs: Date.now() - started }
    const hit = body.found?.[0]
    if (!hit) return { found: null, error: null, durationMs: Date.now() - started }
    const general = hit.date_generale ?? {}
    return {
      found: {
        cui: general.cui, name: general.denumire ?? '', address: general.adresa ?? '',
        registrationStatus: general.stare_inregistrare ?? '', registeredOn: general.data_inregistrare ?? '',
        tradeRegister: general.nrRegCom ?? '', caen: general.cod_CAEN ?? '', legalForm: general.forma_juridica ?? '',
        vatPayer: Boolean(hit.inregistrare_scop_Tva?.scpTVA), inactive: Boolean(hit.stare_inactiv?.statusInactivi),
        eInvoice: Boolean(general.statusRO_e_Factura), queriedAt: new Date().toISOString(), endpoint: ANAF_ENDPOINT,
      },
      error: null, durationMs: Date.now() - started,
    }
  } catch (err) {
    if (signal.aborted) throw err
    return { found: null, error: timeout.aborted ? 'ANAF did not answer within ' + timeoutMs / 1000 + ' s' : 'ANAF unreachable: ' + (err instanceof Error ? err.message : String(err)), durationMs: Date.now() - started }
  }
}

/** Words of the legal form, which the register and dossiers add, drop or spell out differently. */
const LEGAL_FORM = new Set(['SA', 'SRL', 'SCA', 'SNC', 'SCS', 'SOCIETATEA', 'NATIONALA', 'COMERCIALA'])

/** The distinctive words of a company name: no diacritics, punctuation, legal form or dotted abbreviations (S.A., S.N.G.N.). */
export function nameWords(name: string): Set<string> {
  const tokens = name.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9.]+/g, ' ').trim().split(/\s+/)
  return new Set(tokens.filter(t => !/^([A-Z]\.)+[A-Z]?$/.test(t)).map(t => t.replace(/\./g, '')).filter(t => t && !LEGAL_FORM.has(t)))
}

/**
 * Whether the register's name and the dossier's name are the same company:
 * one name's distinctive words all occur in the other, or they spell the same
 * without spaces. "IAR S.A. Brasov" is "IAR SA"; "MEDLIFE S.A." is "MED LIFE SA";
 * "S.N.G.N. ROMGAZ S.A." is "SOCIETATEA NATIONALA DE GAZE NATURALE ROMGAZ SA".
 */
export function sameCompanyName(a: string, b: string): boolean {
  const [small, large] = [nameWords(a), nameWords(b)].sort((x, y) => x.size - y.size)
  return small.size > 0 && ([...small].every(w => large.has(w)) || [...small].join('') === [...large].join(''))
}
