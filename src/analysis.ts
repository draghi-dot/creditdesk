import type { Analysis, AuditRule, Company, Decision, Evidence, Policy, Row, Scenario, Simulation } from './types.ts'
import type { Observations } from './assessment.ts'

export const decisionLabels: Record<Decision, string> = {
  ELIGIBIL: 'Eligible',
  CONDITIONAT: 'Conditional',
  NEELIGIBIL: 'Not eligible',
  DATE_INSUFICIENTE: 'Incomplete',
}
export const scenarioLabels: Record<Scenario, string> = {
  baza: 'Base application',
  garantii_suplimentare: 'Additional collateral',
  garant_suplimentar: 'Additional guarantor',
  cash_colateral: '50% cash collateral',
}
export const scenarioDescriptions: Record<Scenario, string> = {
  baza: 'Assess the application and the collateral originally offered.',
  garantii_suplimentare: 'Include the additional equipment collateral in the dossier.',
  garant_suplimentar: 'Assess a corporate guarantor and its available repayment capacity.',
  cash_colateral: 'Include a 50% cash pledge only when blocking and source of funds are evidenced.',
}
export const money = (n: number | null | undefined, compact = false) => n == null ? '—' : new Intl.NumberFormat('en-GB', {
  style: 'currency', currency: 'RON', maximumFractionDigits: compact ? 1 : 0,
  notation: compact ? 'compact' : 'standard',
}).format(n)
export const ratio = (n: number | null | undefined, digits = 2) => n == null ? '—' : n.toFixed(digits) + '×'
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100
const sum = (values: number[]) => round(values.reduce((a, b) => a + b, 0))
export const documentUrl = (company: Company, doc: Row) => {
  const base = typeof document === 'undefined' ? '/' : document.querySelector('meta[name="creditdesk-asset-base"]')?.getAttribute('content') || '/'
  return base + 'documents/' + company.id + '/' + doc.fisier.split('/').at(-1)
}

/**
 * Apply the policy rules. `observed` holds what an assessment run established
 * from the original documents (missing sources, printed-vs-recorded
 * discrepancies); the dataset's own quality labels are never consulted.
 */
export function evaluate(company: Company, policy: Policy, observed: Observations, scenario: Scenario = 'baza', settings: Simulation = {}): Analysis {
  const t = company.tables
  const request = t.solicitari[0]
  const amount = settings.amount ?? request.suma_solicitata
  const term = settings.months ?? request.durata_luni
  const change = 1 + (settings.cashflowChange ?? 0) / 100
  const selected = t.scenarii.find(r => r.tip_scenariu === scenario)!
  const projected = t.cashflow.filter(r => r.tip_istoric_sau_proiectie === 'proiectie')
  const indicators = Object.fromEntries(t.situatii_financiare.filter(r => r.an === 2025).map(r => [r.cod_indicator, r.valoare]))
  const rules: AuditRule[] = []
  const evidence = (kind: string, field: string, label: string): Evidence[] => {
    const doc = t.documente.find(r => r.tip_document === kind)
    return [{ documentId: doc?.document_id, field, label }]
  }
  const add = (rule: AuditRule) => rules.push(rule)
  const simple = (id: string, area: string, title: string, pass: boolean | null, impact: AuditRule['impact'], observed: string, threshold: string, explanation: string, proof: Evidence[], formula?: string) =>
    add({ id, area, title, state: pass === null ? 'missing' : pass ? 'pass' : impact === 'condition' ? 'review' : 'fail',
      impact: pass === null ? 'data' : impact, observed, threshold, explanation, evidence: proof, formula })

  const missing = observed.missingDocuments
  simple('DATA-01', 'Document integrity', 'Required documents', missing.length === 0, 'data',
    missing.length ? missing.join(', ') : 'All required documents available', 'Complete source documents',
    missing.length ? 'The missing sources prevent a complete assessment. Absence is kept as unknown, rather than replaced with zero.' :
      'All required documents are in the dossier. Each one has an inventory record and a SHA-256 fingerprint.',
    missing.map(kind => ({ field: kind, label: kind.replaceAll('_', ' ') })))
  const balance = t.balanta.filter(r => r.include_in_total)
  const totals = (key: string) => sum(balance.map(r => r[key] * r.unitate))
  const balanced = [
    ['sold_initial_debit', 'sold_initial_credit'],
    ['rulaj_perioada_debit', 'rulaj_perioada_credit'],
    ['sold_final_debit', 'sold_final_credit'],
  ].every(([a, b]) => Math.abs(totals(a) - totals(b)) <= .025)
  simple('DATA-02', 'Document integrity', 'Trial balance reconciliation', balanced, 'data',
    'Closing debit ' + money(totals('sold_final_debit')) + ' / credit ' + money(totals('sold_final_credit')),
    'Debit and credit totals reconcile within RON 0.02',
    balanced ? 'Opening balances, period movements and closing totals reconcile after normalizing the declared units.' :
      'The ledger does not reconcile. Re-extract or correct the source before using its figures for a decision.',
    evidence('balanta', 'sold_final_debit / sold_final_credit', 'September trial balance'),
    'Σ debit − Σ credit = 0, at opening, movements and closing')
  const codes = balance.map(r => r.cod_cont)
  const duplicate = [...new Set(codes.filter((code, i) => codes.indexOf(code) !== i))]
  simple('DATA-03', 'Document integrity', 'Duplicate account detection', duplicate.length === 0, 'data',
    duplicate.length ? 'Duplicated account: ' + duplicate.join(', ') : codes.length + ' unique leaf accounts',
    'No duplicate accounts included in totals',
    duplicate.length ? 'An account is counted more than once. This overstates balances and requires review.' :
      'Each selected leaf account is counted once; parent and child balances are not added together.',
    evidence('balanta', 'cod_cont / include_in_total', 'Ledger account list'))
  const units = [...new Set(balance.map(r => r.unitate))]
  const currencies = [...new Set(balance.map(r => r.moneda))]
  simple('DATA-04', 'Document integrity', 'Currency and unit consistency', units.length === 1 && currencies.length === 1, 'data',
    units.length === 1 && currencies.length === 1 ? currencies[0] + ' · unit ' + units[0] : 'Mixed units: ' + units.join(' and ') + (currencies.length > 1 ? ' · currencies ' + currencies.join(', ') : ''), 'One declared currency and unit per source',
    units.length === 1 ? 'All source amounts share the declared RON unit.' :
      'A row uses thousands while the source declares individual RON. A normalized total alone does not resolve conflicting source metadata.',
    evidence('balanta', 'moneda / unitate', 'Trial balance metadata'))
  const contradictions = observed.discrepancies
  simple('DATA-05', 'Document integrity', 'Cross-document consistency', contradictions.length === 0, 'data',
    contradictions.length ? contradictions.length + ' unresolved discrepancy' : 'No unresolved discrepancies',
    'Values agree across source documents and extracted fields',
    contradictions.length ? contradictions.map(r => r.description).join(' ') :
      'The declared request amount and the source-document extracts agree. No conflicts are recorded.',
    contradictions.length ? contradictions.map(r => ({ documentId: r.documentId, field: r.field, label: 'Conflicting source' })) :
      evidence('cerere_finantare', 'suma_solicitata', 'Financing application'))

  const oldService = t.serviciu_datorie.filter(r => r.tip_existent_sau_nou === 'existent' && r.luna >= '2026-10' && r.luna <= '2027-09')
  const newPrincipal = round(amount / term)
  let left = amount
  const fees = round(amount * request.comisioane / request.suma_solicitata)
  let availableBalance = projected[0]?.sold_initial_numerar ?? 0
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const actualMonth = i < 3 ? '2026-' + String(10 + i).padStart(2, '0') : '2027-' + String(i - 2).padStart(2, '0')
    const old = oldService.filter(r => r.luna === actualMonth)
    const service = round(sum(old.map(r => r.principal_scadent + r.dobanda_scadenta + r.comisioane_scadente)) +
      newPrincipal + round(left * request.dobanda_anuala_ipoteza / 12) + (i === 0 ? fees : 0))
    left = round(left - newPrincipal)
    const cf = projected[i]
    const cfads = cf ? round((cf.incasari_operare - cf.plati_operare_fara_dobanzi_impozite - cf.impozite_platite - cf.capex_mentenanta) * change) : 0
    availableBalance = round(availableBalance + cfads - service + (cf ? cf.aport_capital + cf.alte_finantari - cf.capex_extindere : 0))
    return { month: cf?.luna ?? actualMonth, cfads, service, balance: availableBalance }
  })
  const cfads = projected.length ? sum(monthly.map(r => r.cfads)) : null
  const service = sum(monthly.map(r => r.service))
  const dscr = cfads == null ? null : cfads / service
  const monthlyDscr = projected.length ? Math.min(...monthly.map(r => r.cfads / r.service)) : null
  const liquidity = indicators.ACTIVE_CIRCULANTE != null ? indicators.ACTIVE_CIRCULANTE / indicators.DATORII_CURENTE : null
  const existingDebt = sum(t.credite_leasing.map(r => r.sold_utilizat))
  const leverage = indicators.EBITDA ? (existingDebt + amount) / indicators.EBITDA : null
  simple('FIN-01', 'Repayment capacity', 'Debt service coverage', dscr == null ? null : dscr >= policy.dscr_min, 'block',
    ratio(dscr), 'At least ' + ratio(policy.dscr_min),
    dscr == null ? 'A cash-flow projection is missing. Debt service can be calculated, but available repayment cash cannot.' :
      money(cfads) + ' projected cash available against ' + money(service) + ' of existing and proposed debt payments. ' +
      (dscr >= policy.dscr_min ? 'Repayment headroom meets the policy minimum.' : 'Collateral does not cure this repayment-capacity shortfall.'),
    [...evidence('cashflow', 'CFADS', '12-month cash-flow projection'), ...evidence('serviciu_datorie', 'principal + interest + fees', 'Repayment schedule')],
    'CFADS ÷ (existing + proposed principal, interest and fees)')
  simple('FIN-02', 'Repayment capacity', 'Lowest monthly coverage', monthlyDscr == null ? null : monthlyDscr >= 1, 'block',
    ratio(monthlyDscr), 'At least 1.00× in every projected month',
    monthlyDscr == null ? 'Monthly repayment coverage cannot be assessed without cash-flow data.' :
      'The lowest monthly ratio is ' + ratio(monthlyDscr) + '. This check catches shortfalls that an annual average could hide.',
    evidence('cashflow', 'monthly CFADS / monthly service', 'Monthly cash-flow projection'),
    'Minimum of the 12 monthly CFADS ÷ debt service ratios')
  simple('FIN-03', 'Repayment capacity', 'Current liquidity', liquidity == null ? null : liquidity >= policy.lichiditate_min, 'block',
    ratio(liquidity), 'At least ' + ratio(policy.lichiditate_min),
    liquidity == null ? 'Comparable annual financial statements are missing.' :
      money(indicators.ACTIVE_CIRCULANTE) + ' in current assets against ' + money(indicators.DATORII_CURENTE) + ' in current liabilities, from the 2025 statement.',
    evidence('situatii_2025', 'ACTIVE_CIRCULANTE / DATORII_CURENTE', '2025 financial statements'),
    'Current assets ÷ current liabilities')
  simple('FIN-04', 'Repayment capacity', 'Debt to EBITDA', leverage == null ? null : leverage <= policy.datorie_ebitda_max, 'block',
    ratio(leverage), 'No more than ' + ratio(policy.datorie_ebitda_max),
    leverage == null ? 'EBITDA is unavailable; leverage remains unknown.' :
      money(existingDebt + amount) + ' of existing plus proposed financing divided by ' + money(indicators.EBITDA) + ' of annual EBITDA.',
    [...evidence('situatii_2025', 'EBITDA', '2025 financial statements'), ...evidence('credite_leasing', 'sold_utilizat', 'Credit facility inventory')],
    '(Existing drawn debt + proposed financing) ÷ EBITDA')
  const [fy, fm, fd] = t.companii[0].data_infiintare.split('-').map(Number)
  const age = (2026 - fy) * 12 + 10 - fm - (28 < fd ? 1 : 0)
  simple('KYC-01', 'Company & credit checks', 'Operating history', age >= policy.vechime_min_luni, 'block',
    Math.floor(age / 12) + ' years ' + age % 12 + ' months', 'At least ' + policy.vechime_min_luni + ' months',
    'Calculated from the incorporation date in the company profile.',
    evidence('identificare_kyc_demo', 'data_infiintare', 'Company profile'))
  const contribution = request.aport_propriu / request.buget_investitie * 100
  simple('FIN-05', 'Repayment capacity', 'Own contribution', contribution + .001 >= policy.aport_min_procente, 'block',
    contribution.toFixed(1) + '% · ' + money(request.aport_propriu), 'At least ' + policy.aport_min_procente + '% of investment',
    'The applicant contributes ' + money(request.aport_propriu) + ' toward a ' + money(request.buget_investitie) + ' investment budget.',
    evidence('cerere_finantare', 'aport_propriu / buget_investitie', 'Investment funding breakdown'),
    'Own contribution ÷ investment budget × 100')
  const crc = t.verificari_credit.find(r => r.tip_raport === 'CRC')!
  const creditUnknown = !['obtinut', 'fara_rezultate'].includes(crc.status)
  add({ id: 'CRD-01', area: 'Company & credit checks', title: 'Credit report availability',
    state: creditUnknown ? 'missing' : crc.status === 'fara_rezultate' ? 'review' : 'pass',
    impact: creditUnknown ? 'data' : crc.status === 'fara_rezultate' ? 'condition' : 'none',
    observed: crc.status === 'obtinut' ? 'Credit report available' : crc.status === 'fara_rezultate' ? 'No credit history returned' : 'Credit bureau access error',
    threshold: 'A usable report or explicitly documented absence',
    explanation: creditUnknown ? 'An access failure does not mean the company has no arrears. Obtain the missing report before deciding.' :
      crc.status === 'fara_rezultate' ? 'No credit history was found. This is not the same as a clean report and needs a closer look.' :
        'A credit report is available.',
    evidence: evidence('crc_demo', 'status / facilitati / incidente', 'Credit bureau report') })
  const overdue = Math.max(...t.credite_leasing.map(r => r.zile_intarziere || 0))
  simple('CRD-02', 'Company & credit checks', 'Payment arrears', overdue <= 30, 'block',
    overdue + ' overdue days', 'No facility more than 30 days overdue',
    overdue > 30 ? 'A credit facility has ' + overdue + ' days of arrears. This breaches the credit policy.' :
      'No credit facility is more than 30 days in arrears.',
    evidence('credite_leasing', 'zile_intarziere / restanta_principal', 'Existing facility report'))
  const taxes = t.situatie_fiscala[0].obligatii_restante
  simple('CRD-03', 'Company & credit checks', 'Outstanding tax obligations', taxes === 0, 'block',
    money(taxes), 'No unrescheduled tax arrears',
    taxes > 0 ? 'The fiscal statement lists ' + money(taxes) + ' of unpaid obligations without a repayment arrangement.' :
      'The fiscal statement shows no outstanding tax obligations.',
    evidence('situatie_fiscala', 'obligatii_restante / esalonari', 'Fiscal statement'))

  let collateral = 0
  const cashSelected = scenario === 'cash_colateral'
  let cashVerified = false
  for (const gid of selected.garantie_ids) {
    const g = t.garantii.find(r => r.garantie_id === gid)!
    let valid = g.executabilitate_verificata
    if (g.tip === 'cash') {
      cashVerified = settings.assumeCashVerified ?? (g.cash_blocat_confirmat && selected.blocare_confirmata && (g.sursa_cash || '').includes('verificata'))
      valid = cashVerified
    }
    if (valid) collateral += Math.max(g.valoare_acceptata_banca - g.sarcini_anterioare - g.valoare_alocata_altor_credite, 0)
  }
  let guarantorCapable = false
  if (scenario === 'garant_suplimentar') {
    for (const gid of selected.garant_ids) {
      const g = t.garanti.find(r => r.garant_id === gid)!
      const available = g.venit_sau_cashflow_disponibil_anual - g.serviciu_datorie_anual - g.alte_garantii_asumate
      const newAnnualService = service - sum(oldService.map(r => r.principal_scadent + r.dobanda_scadenta + r.comisioane_scadente))
      guarantorCapable ||= g.capacitate_validata && available >= newAnnualService * 1.2
      simple('COL-02', 'Collateral & guarantees', 'Guarantor repayment capacity', guarantorCapable, 'condition',
        money(available) + ' net annual capacity', 'At least 1.20× the proposed annual debt service',
        'Available guarantor cash is calculated after its own debt service and other commitments. ' +
        (guarantorCapable ? 'The verified guarantor can cover the collateral exception.' : 'The selected guarantor cannot remedy the collateral shortfall.'),
        evidence('garanti', 'available annual cash / commitments', 'Guarantor financial profile'),
        '(Available cash − own debt service − commitments) ≥ new annual service × 1.20')
    }
  }
  if (cashSelected) {
    simple('COL-03', 'Collateral & guarantees', 'Cash pledge evidence', cashVerified, 'condition',
      cashVerified ? 'Blocking and source confirmed' : 'Blocking or source not evidenced',
      'Both blocking confirmation and verified source of funds',
      cashVerified ? (settings.assumeCashVerified ? 'What-if assumption: cash evidence is treated as verified for this calculation only. Source files are unchanged.' :
        'Blocked cash with a verified source of funds is on record. This cash is excluded from available cash balances.') :
        'Unblocked or unverified cash is excluded from eligible collateral. Obtain proof before relying on it.',
      evidence('garantii', 'cash_blocat_confirmat / sursa_cash', 'Cash collateral evidence'))
  }
  const coverage = collateral / amount
  simple('COL-01', 'Collateral & guarantees', 'Accepted collateral coverage', coverage >= 1.1 || guarantorCapable, 'condition',
    (coverage * 100).toFixed(0) + '% · ' + money(collateral), 'At least 110%, or a capable verified guarantor',
    money(collateral) + ' of accepted, enforceable collateral after haircuts and prior allocations against ' + money(amount) + ' financing. ' +
    (guarantorCapable ? 'The guarantor exception applies.' : coverage >= 1.1 ? 'Coverage meets the policy threshold.' :
      'Add eligible collateral, establish a capable guarantor, or evidence the cash pledge.'),
    evidence('garantii', 'valoare_acceptata_banca / sarcini / alocari', 'Collateral valuation schedule'),
    'Eligible accepted collateral ÷ scenario financing amount')
  for (const [index, lit] of t.litigii.entries()) {
    const unknown = lit.potrivire_entitate !== 'confirmata'
    const material = lit.rol_procesual === 'parat' && lit.expunere_estimata > amount * .2
    simple('LEG-' + (index + 1), 'Legal review', unknown ? 'Litigation identity match' : 'Litigation exposure',
      !unknown && !material, 'condition',
      unknown ? 'Entity match not confirmed' : (lit.rol_procesual === 'reclamant' ? 'Claimant' : 'Defendant') + ' · ' + money(lit.expunere_estimata) + ' exposure',
      'Confirm identity; review defendant exposure above 20% of financing',
      unknown ? 'A name match in the litigation register has not been confirmed as this company.' :
        material ? 'The exposure as defendant is material and needs legal review before proceeding.' :
          'The company is the claimant. This does not by itself imply repayment risk or a rejection.',
      evidence('litigii_demo', 'rol_procesual / expunere_estimata / potrivire_entitate', 'Litigation register'))
  }
  if (!t.litigii.length) add({ id: 'LEG-00', area: 'Legal review', title: 'Litigation source scope', state: 'info', impact: 'none',
    observed: 'No cases in the register extract', threshold: 'An empty extract is not a legal clearance',
    explanation: 'The litigation register extract in the dossier lists no cases. Court portals and the insolvency register are not queried by this check.',
    evidence: evidence('litigii_demo', 'register scope', 'Litigation register') })
  const failing = rules.filter(r => r.state !== 'pass' && r.state !== 'info')
  const dataReasons = failing.filter(r => r.impact === 'data')
  const blockers = failing.filter(r => r.impact === 'block')
  const conditions = failing.filter(r => r.impact === 'condition')
  const decision: Decision = dataReasons.length ? 'DATE_INSUFICIENTE' : blockers.length ? 'NEELIGIBIL' : conditions.length ? 'CONDITIONAT' : 'ELIGIBIL'
  return { decision, scenario, rules, reasons: dataReasons.length ? dataReasons : blockers.length ? blockers : conditions,
    metrics: { amount, dscr, monthlyDscr, cfads, debtService: service, liquidity, leverage, coverage, collateral, contribution, ageMonths: age, guarantorCapable },
    monthly: projected.length ? monthly : [] }
}
