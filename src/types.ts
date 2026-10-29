import type { CreditLine } from './monitoring'
// The source tables have different schemas; their original fields are preserved.
export type Row = Record<string, any>
export type Decision = 'ELIGIBIL' | 'CONDITIONAT' | 'NEELIGIBIL' | 'DATE_INSUFICIENTE'
export type Scenario = 'baza' | 'garantii_suplimentare' | 'garant_suplimentar' | 'cash_colateral'
export type RuleState = 'pass' | 'fail' | 'review' | 'missing' | 'info'
export interface Company {
  id: string
  symbol: string
  name: string
  cui: string
  sector: string
  city: string
  tables: Record<string, Row[]>
  /** Set for credit clients: the approved and drawn financing. */
  creditLine?: CreditLine
  /** Names the company goes by in the news, for monitoring. */
  monitorTerms?: string[]
  /** False for a company not listed on the exchange. */
  listed?: boolean
}
export interface Policy {
  politica_id: string
  versiune: string
  dscr_min: number
  lichiditate_min: number
  datorie_ebitda_max: number
  vechime_min_luni: number
  aport_min_procente: number
  [key: string]: any
}
export interface Portfolio {
  companies: Company[]
  policy: Policy
  metadata: { financialDate: string; analysisDate: string; synthetic: boolean; source: string }
}
export interface Evidence {
  documentId?: string
  field: string
  label: string
}
export interface AuditRule {
  id: string
  area: string
  title: string
  state: RuleState
  impact: 'data' | 'block' | 'condition' | 'none'
  observed: string
  threshold: string
  formula?: string
  explanation: string
  evidence: Evidence[]
}
export interface Simulation {
  amount?: number
  months?: number
  cashflowChange?: number
  assumeCashVerified?: boolean
}
export interface Analysis {
  decision: Decision
  scenario: Scenario
  rules: AuditRule[]
  reasons: AuditRule[]
  metrics: {
    amount: number
    dscr: number | null
    monthlyDscr: number | null
    cfads: number | null
    debtService: number
    liquidity: number | null
    leverage: number | null
    coverage: number
    collateral: number
    contribution: number
    ageMonths: number
    guarantorCapable: boolean
  }
  monthly: { month: string; cfads: number; service: number; balance: number }[]
}
export interface AuditEvent {
  id: string
  companyId: string
  time: string
  action: string
  detail: string
  actor: string
  previousHash: string
  hash: string
  payload?: any
}
