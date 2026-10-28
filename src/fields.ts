/** Plain-English names for the fields printed in the dossier documents, and how to show their values. */

export const FIELD_LABELS: Record<string, string> = {
  // Financing application
  suma_solicitata: 'Requested amount', durata_luni: 'Term (months)', gratie_luni: 'Grace period (months)', comisioane: 'Fees',
  buget_investitie: 'Investment budget', aport_propriu: 'Own contribution', necesar_capital_lucru: 'Working capital need',
  dobanda_anuala_ipoteza: 'Annual interest assumption', tip_finantare: 'Financing type', tip_facilitate: 'Facility type', scop: 'Purpose',
  rambursare: 'Repayment', moneda: 'Currency', cui: 'CUI', data_analiza: 'Analysis date', tratament_tva: 'VAT treatment',
  // Company profile
  denumire: 'Company name', data_infiintare: 'Incorporation date', forma_juridica: 'Legal form', caen: 'CAEN code', status_juridic: 'Legal status',
  sediu: 'Registered office', nr_registru: 'Trade register no.', tara: 'Country',
  // Trial balance
  cod_cont: 'Account', denumire_cont: 'Account name', unitate: 'Unit', sold_initial_debit: 'Opening debit', sold_initial_credit: 'Opening credit',
  rulaj_perioada_debit: 'Debit movements', rulaj_perioada_credit: 'Credit movements', sold_final_debit: 'Closing debit', sold_final_credit: 'Closing credit',
  include_in_total: 'Included in totals', nivel: 'Level', cont_parinte: 'Parent account', perioada_start: 'Period start', perioada_end: 'Period end',
  // Cash flow
  luna: 'Month', tip_istoric_sau_proiectie: 'Actual or projected', incasari_operare: 'Operating receipts',
  plati_operare_fara_dobanzi_impozite: 'Operating payments (excl. interest and tax)', impozite_platite: 'Taxes paid', capex_mentenanta: 'Maintenance capex',
  capex_extindere: 'Expansion capex', aport_capital: 'Capital contribution', alte_finantari: 'Other financing', sold_initial_numerar: 'Opening cash',
  principal_existent: 'Existing principal', dobanzi_existente: 'Existing interest', principal_nou: 'New principal', dobanzi_noi: 'New interest',
  // Financial statements
  valoare: 'Value', cod_indicator: 'Indicator', denumire_indicator: 'Indicator name', an: 'Year',
  // Credit facilities and repayment schedules
  facilitate_id: 'Facility', creditor: 'Creditor', plafon: 'Limit', sold_utilizat: 'Drawn balance', sold_neutilizat: 'Undrawn balance',
  restanta_principal: 'Principal arrears', restanta_dobanda: 'Interest arrears', zile_intarziere: 'Days overdue', rata_dobanda_anuala: 'Annual rate',
  principal_scadent: 'Principal due', dobanda_scadenta: 'Interest due', comisioane_scadente: 'Fees due', tip_existent_sau_nou: 'Existing or new',
  // Collateral and guarantors
  garantie_id: 'Collateral', tip: 'Type', valoare_evaluata: 'Appraised value', valoare_acceptata_banca: 'Value accepted by the bank',
  haircut_procente: 'Haircut', sarcini_anterioare: 'Prior charges', rang: 'Rank', valoare_alocata_altor_credite: 'Allocated to other loans',
  executabilitate_verificata: 'Enforceability verified', cash_blocat_confirmat: 'Cash blocking confirmed', sursa_cash: 'Source of cash',
  garant_id: 'Guarantor', venit_sau_cashflow_disponibil_anual: 'Available annual cash flow', serviciu_datorie_anual: 'Annual debt service',
  alte_garantii_asumate: 'Other guarantees given', capacitate_validata: 'Capacity validated',
  // Credit, tax and legal
  status: 'Status', data_raport: 'Report date', incidente: 'Incidents', facilitati: 'Facilities', obligatii_restante: 'Outstanding tax obligations',
  esalonari: 'Payment arrangements', status_inactivitate: 'Taxpayer status', rol_procesual: 'Role in the case', expunere_estimata: 'Estimated exposure',
  potrivire_entitate: 'Identity match', numar_dosar: 'Case number', nume_parte: 'Party', pretentii_valoare: 'Claim value',
}

/** Financial-statement indicators, as named in the statements. */
export const INDICATOR_LABELS: Record<string, string> = {
  CA_NET: 'Net turnover', EBITDA: 'EBITDA', ACTIVE_CIRCULANTE: 'Current assets', DATORII_CURENTE: 'Current liabilities',
  DOBANZI: 'Interest expense', NUMERAR_BLOCAT: 'Restricted cash', PROFIT_NET: 'Net profit', CAPITALURI_PROPRII: 'Equity',
}

const NOT_MONEY = new Set(['durata_luni', 'gratie_luni', 'unitate', 'nivel', 'zile_intarziere', 'rang', 'an', 'cod_cont', 'caen', 'cui', 'luna', 'cont_parinte'])
const FRACTION_PERCENT = new Set(['dobanda_anuala_ipoteza', 'rata_dobanda_anuala'])

export const fieldLabel = (key: string) => FIELD_LABELS[key] ?? key.replaceAll('_', ' ')

export function fieldValue(key: string, raw: string): string {
  const text = raw.trim()
  if (text === 'da') return 'yes'
  if (text === 'nu') return 'no'
  if (text === 'NECUNOSCUT / neaplicabil') return 'not applicable'
  if (!/^-?\d+(\.\d+)?$/.test(text)) return text
  const n = Number(text)
  if (FRACTION_PERCENT.has(key)) return (n * 100).toFixed(2) + '%'
  if (key === 'haircut_procente') return n + '%'
  if (NOT_MONEY.has(key)) return text
  return 'RON ' + n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** "Operating receipts: RON 415,871.77" for `incasari_operare: 415871.77`. */
export const describeField = (key: string, raw: string) => fieldLabel(key) + ': ' + fieldValue(key, raw)
