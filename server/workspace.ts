/**
 * The people side of the workspace, in the same database as the run log:
 * employees, cases sent to departments and their timelines, company
 * contacts, requests to companies, Gmail connections, and each company's
 * activity log (hash-chained per company, verifiable in the browser).
 */

import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Finding } from '../src/assessment.ts'
import type { Company } from '../src/types.ts'
import type { ActivityEvent, Case, CaseEvent, CaseEventKind, CaseStatus, ClientRisk, CompanyRequest, Contact, DepartmentId, SuggestionSet, User, WorkspaceSettings } from '../src/workspace.ts'
import type { CreditLine } from '../src/monitoring.ts'
import { DEPARTMENTS, undeliverable } from '../src/workspace.ts'

/** The employees a new workspace starts with. The first is signed in by default. */
const STAFF: Omit<User, 'initials'>[] = [
  { id: 'u-legal-1', name: 'Ioana Marinescu', title: 'Legal counsel', department: 'legal' },
  { id: 'u-legal-2', name: 'Radu Ionescu', title: 'Legal advisor', department: 'legal' },
  { id: 'u-finance-1', name: 'Andrei Popa', title: 'Financial analyst', department: 'finance' },
  { id: 'u-finance-2', name: 'Cristina Dobre', title: 'Senior financial analyst', department: 'finance' },
  { id: 'u-credit-1', name: 'Elena Dumitrescu', title: 'Credit analyst', department: 'credit' },
  { id: 'u-compliance-1', name: 'Mihai Stoica', title: 'Compliance officer', department: 'compliance' },
]
export const DEFAULT_USER = STAFF[0].id

const GENESIS = '0'.repeat(64)
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const now = () => new Date().toISOString()
const initials = (name: string) => name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase()
const isDepartment = (d: unknown): d is DepartmentId => DEPARTMENTS.some(x => x.id === d)

export class Workspace {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, title TEXT NOT NULL, department TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
        added_by TEXT NOT NULL, added_at TEXT NOT NULL, removed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, company_id TEXT NOT NULL, company_name TEXT NOT NULL, run_id TEXT, finding TEXT,
        department TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, assignee TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cases_department ON cases (department, updated_at);
      CREATE INDEX IF NOT EXISTS cases_company ON cases (company_id, updated_at);
      CREATE TABLE IF NOT EXISTS case_events (id TEXT PRIMARY KEY, case_id TEXT NOT NULL, ts TEXT NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, data TEXT);
      CREATE INDEX IF NOT EXISTS case_events_case ON case_events (case_id, ts);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, case_id TEXT, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_company ON requests (company_id, created_at);
      CREATE TABLE IF NOT EXISTS suggestions (run_id TEXT PRIMARY KEY, company_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gmail (user_id TEXT PRIMARY KEY, email TEXT NOT NULL, refresh_token TEXT NOT NULL, connected_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, time TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_company ON activity (company_id, time);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS client_risk (company_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS signed_clients (company_id TEXT PRIMARY KEY, signed_at TEXT NOT NULL, payload TEXT NOT NULL);
    `)
    const columns = (db.prepare('PRAGMA table_info(contacts)').all() as { name: string }[]).map(c => c.name)
    if (!columns.includes('source')) db.exec("ALTER TABLE contacts ADD COLUMN source TEXT NOT NULL DEFAULT 'added'; ALTER TABLE contacts ADD COLUMN source_url TEXT; ALTER TABLE contacts ADD COLUMN verified INTEGER")
    if (!(db.prepare('SELECT count(*) n FROM users').get() as { n: number }).n) {
      const insert = db.prepare('INSERT INTO users (id, name, title, department, created_at) VALUES (?, ?, ?, ?, ?)')
      for (const u of STAFF) insert.run(u.id, u.name, u.title, u.department, now())
    }
  }

  // ─── Employees ─────────────────────────────────────────────────────────────

  users(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at, name').all() as Record<string, string>[])
      .map(r => ({ id: r.id, name: r.name, title: r.title, department: r.department as DepartmentId, initials: initials(r.name) }))
  }

  user(id: string | undefined | null): User | null {
    return this.users().find(u => u.id === id) ?? null
  }

  addUser(input: { name?: unknown; title?: unknown; department?: unknown }): User {
    const name = String(input.name ?? '').trim().slice(0, 80)
    const title = String(input.title ?? '').trim().slice(0, 80)
    if (name.length < 2) throw Object.assign(new Error('Enter the employee\'s name'), { status: 400 })
    if (!isDepartment(input.department)) throw Object.assign(new Error('Choose a department'), { status: 400 })
    const id = 'u-' + randomUUID().slice(0, 8)
    this.db.prepare('INSERT INTO users (id, name, title, department, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name, title || 'Employee', input.department, now())
    return this.user(id)!
  }

  // ─── Company contacts ──────────────────────────────────────────────────────

  /** The dossier's representatives followed by the contacts employees added. */
  contacts(company: Company): Contact[] {
    const dossier: Contact[] = (company.tables.companii[0]?.administratori ?? []).map((a: any, i: number) => {
      const placeholder = undeliverable(String(a.email ?? ''))
      return {
        id: company.id + '-dossier-' + i, companyId: company.id, source: 'dossier', placeholder, addedBy: null, addedAt: null,
        // Without a deliverable address the dossier has no real contact on file, only a role.
        name: placeholder ? 'Representative (no contact on file)' : String(a.nume), role: String(a.rol ?? 'administrator').replace(/_fictiv$/, '').replaceAll('_', ' '),
        email: placeholder ? '' : String(a.email), phone: '', sourceUrl: null, verified: null,
      }
    })
    const added = (this.db.prepare("SELECT * FROM contacts WHERE company_id = ? AND removed_at IS NULL ORDER BY source = 'public', added_at").all(company.id) as Record<string, any>[])
      .map(r => ({
        id: r.id, companyId: r.company_id, name: r.name, role: r.role, email: r.email, phone: r.phone, source: r.source, placeholder: !r.email || undeliverable(r.email),
        addedBy: r.added_by, addedAt: r.added_at, sourceUrl: r.source_url ?? null, verified: r.verified === null || r.verified === undefined ? null : Boolean(r.verified),
      } as Contact))
    return [...added, ...dossier]
  }

  /** A contact the assistant found in public sources; replaces its earlier find from the same source. */
  savePublicContact(companyId: string, contact: { name: string; role: string; email: string; phone: string; sourceUrl: string; verified: boolean }, foundBy: string): void {
    this.db.prepare("UPDATE contacts SET removed_at = ? WHERE company_id = ? AND source = 'public' AND role = ? AND removed_at IS NULL").run(now(), companyId, contact.role)
    this.db.prepare("INSERT INTO contacts (id, company_id, name, role, email, phone, added_by, added_at, source, source_url, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'public', ?, ?)")
      .run(randomUUID(), companyId, contact.name.slice(0, 120), contact.role.slice(0, 80), contact.email.slice(0, 200), contact.phone.slice(0, 40), foundBy, now(), contact.sourceUrl.slice(0, 500), contact.verified ? 1 : 0)
  }

  // ─── Early warning ─────────────────────────────────────────────────────────

  risk(companyId: string): ClientRisk {
    const row = this.db.prepare('SELECT payload FROM client_risk WHERE company_id = ?').get(companyId) as { payload: string } | undefined
    return row ? JSON.parse(row.payload) : { companyId, watchlist: null, freeze: null }
  }

  saveRisk(risk: ClientRisk): ClientRisk {
    this.db.prepare('INSERT INTO client_risk (company_id, payload) VALUES (?, ?) ON CONFLICT(company_id) DO UPDATE SET payload = excluded.payload').run(risk.companyId, JSON.stringify(risk))
    return risk
  }

  allRisk(): ClientRisk[] {
    return (this.db.prepare('SELECT payload FROM client_risk').all() as { payload: string }[]).map(r => JSON.parse(r.payload))
  }

  // ─── Signed clients ────────────────────────────────────────────────────────

  /** Applications whose contract was signed, with the credit line made from them. */
  signedClients(): { companyId: string; signedAt: string; creditLine: CreditLine }[] {
    return (this.db.prepare('SELECT company_id, signed_at, payload FROM signed_clients ORDER BY signed_at').all() as Record<string, string>[]).map(r => ({ companyId: r.company_id, signedAt: r.signed_at, creditLine: JSON.parse(r.payload) }))
  }

  saveSignedClient(companyId: string, creditLine: CreditLine): void {
    this.db.prepare('INSERT INTO signed_clients (company_id, signed_at, payload) VALUES (?, ?, ?) ON CONFLICT(company_id) DO UPDATE SET payload = excluded.payload').run(companyId, new Date().toISOString(), JSON.stringify(creditLine))
  }

  // ─── Settings ──────────────────────────────────────────────────────────────

  /** Sending is simulated unless real email is switched on for the engine (CREDITDESK_REAL_EMAIL=on). */
  settings(): WorkspaceSettings {
    const realEmail = process.env.CREDITDESK_REAL_EMAIL === 'on'
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'delivery'").get() as { value: string } | undefined
    return { delivery: !realEmail ? 'simulated' : row?.value === 'live' ? 'live' : row?.value === 'test' ? 'test' : 'simulated', realEmail }
  }

  setDelivery(delivery: unknown): WorkspaceSettings {
    if (delivery !== 'simulated' && delivery !== 'test' && delivery !== 'live') throw Object.assign(new Error('Delivery is simulated, test or live'), { status: 400 })
    if (delivery !== 'simulated' && process.env.CREDITDESK_REAL_EMAIL !== 'on') throw Object.assign(new Error('Real email is switched off in this workspace: sending is simulated.'), { status: 400 })
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('delivery', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(delivery)
    return this.settings()
  }

  saveContact(companyId: string, input: { id?: unknown; name?: unknown; role?: unknown; email?: unknown; phone?: unknown }, by: User): Contact['id'] {
    const name = String(input.name ?? '').trim().slice(0, 120)
    const email = String(input.email ?? '').trim().slice(0, 200)
    if (name.length < 2) throw Object.assign(new Error('Enter the contact\'s name'), { status: 400 })
    if (email && undeliverable(email)) throw Object.assign(new Error('Enter a valid email address'), { status: 400 })
    const role = String(input.role ?? '').trim().slice(0, 80) || 'Representative'
    const phone = String(input.phone ?? '').trim().slice(0, 40)
    if (typeof input.id === 'string' && this.db.prepare('SELECT 1 FROM contacts WHERE id = ? AND company_id = ? AND removed_at IS NULL').get(input.id, companyId)) {
      this.db.prepare('UPDATE contacts SET name = ?, role = ?, email = ?, phone = ? WHERE id = ?').run(name, role, email, phone, input.id)
      return input.id
    }
    const id = randomUUID()
    this.db.prepare('INSERT INTO contacts (id, company_id, name, role, email, phone, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, companyId, name, role, email, phone, by.name, now())
    return id
  }

  removeContact(companyId: string, id: string): boolean {
    return this.db.prepare('UPDATE contacts SET removed_at = ? WHERE id = ? AND company_id = ? AND removed_at IS NULL').run(now(), id, companyId).changes > 0
  }

  // ─── Cases ─────────────────────────────────────────────────────────────────

  private caseRow(r: Record<string, any>): Case {
    return {
      id: r.id, ref: '#' + r.number, companyId: r.company_id, companyName: r.company_name, runId: r.run_id, finding: r.finding ? JSON.parse(r.finding) : null,
      department: r.department, title: r.title, status: r.status, assignee: r.assignee, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
    }
  }

  cases(filter: { department?: string; companyId?: string; status?: string } = {}): Case[] {
    const where: string[] = []
    const args: string[] = []
    for (const [column, value] of [['department', filter.department], ['company_id', filter.companyId], ['status', filter.status]] as const) if (value) { where.push(column + ' = ?'); args.push(value) }
    return (this.db.prepare('SELECT * FROM cases' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY updated_at DESC').all(...args) as Record<string, any>[]).map(r => this.caseRow(r))
  }

  case(id: string): Case | null {
    const row = this.db.prepare('SELECT * FROM cases WHERE id = ?').get(id) as Record<string, any> | undefined
    return row ? this.caseRow(row) : null
  }

  /**
   * Send a problem to a department. A problem already open in that department
   * is not opened twice: the existing case is returned (with the note added).
   */
  openCase(input: { company: Company; runId: string | null; finding: Finding | null; department: unknown; title?: unknown; note?: unknown }, by: User): { case: Case; created: boolean } {
    if (!isDepartment(input.department)) throw Object.assign(new Error('Choose a department'), { status: 400 })
    const title = String(input.title ?? input.finding?.title ?? '').trim().slice(0, 200)
    if (!title) throw Object.assign(new Error('Describe the problem'), { status: 400 })
    const note = String(input.note ?? '').trim().slice(0, 4000)
    const existing = input.finding && this.cases({ companyId: input.company.id, department: input.department })
      .find(c => c.status !== 'resolved' && c.finding?.id === input.finding!.id && c.finding?.title === input.finding!.title)
    if (existing) {
      if (note) this.addEvent(existing.id, 'comment', note, by)
      return { case: this.case(existing.id)!, created: false }
    }
    const id = randomUUID()
    const number = ((this.db.prepare('SELECT max(number) n FROM cases').get() as { n: number | null }).n ?? 100) + 1
    const ts = now()
    this.db.prepare('INSERT INTO cases (id, number, company_id, company_name, run_id, finding, department, title, status, assignee, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, number, input.company.id, input.company.name, input.runId, input.finding ? JSON.stringify(input.finding) : null, input.department, title, 'open', null, by.name, ts, ts)
    this.addEvent(id, 'opened', note, by, { department: input.department })
    this.appendActivity(input.company.id, 'Problem sent to ' + DEPARTMENTS.find(d => d.id === input.department)!.name, title + (note ? ' — ' + note : ''), by.name, { caseId: id, ref: '#' + number })
    return { case: this.case(id)!, created: true }
  }

  events(caseId: string): CaseEvent[] {
    return (this.db.prepare('SELECT * FROM case_events WHERE case_id = ? ORDER BY ts, rowid').all(caseId) as Record<string, any>[])
      .map(r => ({ id: r.id, caseId: r.case_id, ts: r.ts, author: r.author, kind: r.kind, text: r.text, ...(r.data ? { data: JSON.parse(r.data) } : {}) }))
  }

  addEvent(caseId: string, kind: CaseEventKind, text: string, by: User | string, data?: unknown): CaseEvent {
    const event: CaseEvent = { id: randomUUID(), caseId, ts: now(), author: typeof by === 'string' ? by : by.name, kind, text, ...(data === undefined ? {} : { data }) }
    this.db.prepare('INSERT INTO case_events (id, case_id, ts, author, kind, text, data) VALUES (?, ?, ?, ?, ?, ?, ?)').run(event.id, caseId, event.ts, event.author, kind, text, data === undefined ? null : JSON.stringify(data))
    this.db.prepare('UPDATE cases SET updated_at = ? WHERE id = ?').run(event.ts, caseId)
    return event
  }

  /** Status, assignee or department changes, each recorded on the case timeline. */
  updateCase(id: string, change: { status?: unknown; assignee?: unknown; department?: unknown }, by: User): Case {
    const current = this.case(id)
    if (!current) throw Object.assign(new Error('No such case'), { status: 404 })
    if (change.status !== undefined) {
      const status = change.status as CaseStatus
      if (!['open', 'in_progress', 'waiting', 'resolved'].includes(status)) throw Object.assign(new Error('Unknown status'), { status: 400 })
      if (status !== current.status) {
        this.db.prepare('UPDATE cases SET status = ? WHERE id = ?').run(status, id)
        this.addEvent(id, 'status', '', by, { from: current.status, to: status })
      }
    }
    if (change.assignee !== undefined) {
      const assignee = change.assignee === null ? null : this.user(String(change.assignee))
      if (change.assignee !== null && !assignee) throw Object.assign(new Error('Unknown employee'), { status: 400 })
      if ((assignee?.name ?? null) !== current.assignee) {
        this.db.prepare('UPDATE cases SET assignee = ? WHERE id = ?').run(assignee?.name ?? null, id)
        this.addEvent(id, 'assigned', '', by, { to: assignee?.name ?? null })
      }
    }
    if (change.department !== undefined && change.department !== current.department) {
      if (!isDepartment(change.department)) throw Object.assign(new Error('Choose a department'), { status: 400 })
      this.db.prepare('UPDATE cases SET department = ?, assignee = NULL WHERE id = ?').run(change.department, id)
      this.addEvent(id, 'moved', '', by, { from: current.department, to: change.department })
    }
    return this.case(id)!
  }

  // ─── Requests to companies ─────────────────────────────────────────────────

  requests(filter: { companyId?: string; caseId?: string }): CompanyRequest[] {
    const rows = (filter.caseId
      ? this.db.prepare('SELECT payload FROM requests WHERE case_id = ? ORDER BY created_at DESC').all(filter.caseId)
      : filter.companyId !== undefined ? this.db.prepare('SELECT payload FROM requests WHERE company_id = ? ORDER BY created_at DESC').all(filter.companyId)
      : this.db.prepare('SELECT payload FROM requests ORDER BY created_at DESC').all()) as { payload: string }[]
    return rows.map(r => JSON.parse(r.payload))
  }

  request(id: string): CompanyRequest | null {
    const row = this.db.prepare('SELECT payload FROM requests WHERE id = ?').get(id) as { payload: string } | undefined
    return row ? JSON.parse(row.payload) : null
  }

  saveRequest(request: CompanyRequest): CompanyRequest {
    this.db.prepare('INSERT INTO requests (id, company_id, case_id, created_at, payload) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload')
      .run(request.id, request.companyId, request.caseId, request.createdAt, JSON.stringify(request))
    return request
  }

  // ─── Assistant suggestions ─────────────────────────────────────────────────

  suggestions(runId: string): SuggestionSet | null {
    const row = this.db.prepare('SELECT payload FROM suggestions WHERE run_id = ?').get(runId) as { payload: string } | undefined
    return row ? JSON.parse(row.payload) : null
  }

  saveSuggestions(runId: string, companyId: string, set: SuggestionSet): SuggestionSet {
    this.db.prepare('INSERT INTO suggestions (run_id, company_id, created_at, payload) VALUES (?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET created_at = excluded.created_at, payload = excluded.payload')
      .run(runId, companyId, set.createdAt, JSON.stringify(set))
    return set
  }

  // ─── Gmail connections ─────────────────────────────────────────────────────

  gmail(userId: string): { email: string; refreshToken: string; connectedAt: string } | null {
    const row = this.db.prepare('SELECT * FROM gmail WHERE user_id = ?').get(userId) as Record<string, string> | undefined
    return row ? { email: row.email, refreshToken: row.refresh_token, connectedAt: row.connected_at } : null
  }

  saveGmail(userId: string, email: string, refreshToken: string): void {
    this.db.prepare('INSERT INTO gmail (user_id, email, refresh_token, connected_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token, connected_at = excluded.connected_at')
      .run(userId, email, refreshToken, now())
  }

  removeGmail(userId: string): void {
    this.db.prepare('DELETE FROM gmail WHERE user_id = ?').run(userId)
  }

  // ─── Company activity log ──────────────────────────────────────────────────

  activity(companyId?: string): ActivityEvent[] {
    const rows = (companyId
      ? this.db.prepare('SELECT payload FROM activity WHERE company_id = ? ORDER BY time, rowid').all(companyId)
      : this.db.prepare('SELECT payload FROM activity ORDER BY time, rowid').all()) as { payload: string }[]
    return rows.map(r => JSON.parse(r.payload))
  }

  /** Append to a company's log; the hash covers the event exactly as the browser re-serializes it to verify. */
  appendActivity(companyId: string, action: string, detail: string, actor: string, payload?: unknown): ActivityEvent {
    const last = this.db.prepare('SELECT payload FROM activity WHERE company_id = ? ORDER BY time DESC, rowid DESC LIMIT 1').get(companyId) as { payload: string } | undefined
    const body = {
      id: randomUUID(), companyId, time: now(), action: action.slice(0, 200), detail: detail.slice(0, 4000), actor,
      previousHash: last ? (JSON.parse(last.payload) as ActivityEvent).hash : GENESIS, ...(payload === undefined ? {} : { payload }),
    }
    const event = { ...body, hash: sha256(JSON.stringify(body)) } as ActivityEvent
    this.db.prepare('INSERT INTO activity (id, company_id, time, payload) VALUES (?, ?, ?, ?)').run(event.id, companyId, event.time, JSON.stringify(event))
    return event
  }
}
