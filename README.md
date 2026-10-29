# Finra

Internal corporate-lending workspace for reviewing 50 company financing applications, used by employees in four departments (Legal, Finance, Credit, Compliance). A React + TypeScript + Vite workspace backed by a local **assessment engine** (Node 25, no framework) that runs real review workers over each dossier's original PDFs.

## Run

    cd /Users/robert/Desktop/hack/banking-workspace
    npm run dev          # engine on :8787 + Vite on http://127.0.0.1:5173 (/api is proxied)

Production: `npm run build && npm start` serves the built workspace and the API from one process on :8787.

Requirements: Node 25 (TypeScript runs natively, `node:sqlite` built in), Poppler (`pdftotext`, `pdftoppm`), and for model calls the Codex CLI signed in (`codex login`). Ports and options:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `ENGINE_PORT` | 8787 | Engine port (`ENGINE_PORT` is what `npm run dev` passes to both sides) |
| `VITE_PORT` | 5173 | Dev workspace port |
| `CREDITDESK_DATA` | `.data/` | Run database and rendered page cache |
| `CREDITDESK_LLM` | `codex` | `none` runs deterministic workers only |
| `CODEX_MODEL` / `CODEX_EFFORT` | `gpt-6.1-sol` / `medium` | Model for the legal reading and the analyst memo |
| `CODEX_TIMEOUT_MS` | 180000 | Longest wait for one model answer before the engine writes its own text instead |
| `CREDITDESK_MONITOR` | on | `off` stops the scheduled monitoring of credit clients (tests use this) |
| `CREDITDESK_MONITOR_MINUTES` | 60 | How often each credit client is checked |
| `CREDITDESK_MONITOR_WEB` | on | `off` skips the news part of monitoring |
| `CREDITDESK_BATCH_CONCURRENCY` | 2 with the model, 6 without | How many assessments Run all keeps going at once |
| `CREDITDESK_ANAF` | on | `off` skips the live ANAF lookup (tests use this) |
| `CREDITDESK_PACE` | 1 | How long each assessment step stays in view (1 ≈ a minute per run before the model; 0 runs flat out, as the tests do) |
| `CREDITDESK_CRAWL_MODEL` | `gpt-6-luna` | The light model (low effort, one call per check, titles and quoted sentences only) that judges the news; the keyword rules decide when no model answers |
| `CREDITDESK_MONITOR_OPEN` | 12 | Articles the news crawler opens per client per check, newest first |
| `CREDITDESK_REAL_EMAIL` | off | Sending is simulated (recorded as sent, nothing leaves Finra) unless this is `on`; then test and live Gmail delivery can be chosen |
| `CREDITDESK_ONBOARD` | on | Assesses, at start, any credit client without a completed assessment |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | Google OAuth client for Gmail (or save the client JSON as `.data/google-oauth.json`) |

## How an assessment works

Opening a company shows its header and two actions. **Nothing runs on open.**

- **View assessment** opens the latest *completed* run. If there is none, the page says so; no history is generated and no outcome is shown for companies that were never assessed.
- **Run new assessment** starts a run on the engine and opens the live workspace.

A run is an append-only, SHA-256 hash-chained event log (`server/store.ts`). The workspace folds the events it receives (`foldRun` in `src/assessment.ts`); there is no clock or scripted duration. Live view, reload mid-run and the completed assessment all render from the same fold.

Ten roles with code-defined dependencies (`ROLES`). A worker appears on the map when one of its dependencies is dispatched (waiting, with the dependencies it still waits for) and starts when all are complete:

| Worker | What it actually does |
|---|---|
| Case coordinator | Recomputes the SHA-256 of every PDF against the inventory; checks the 16-document checklist |
| Identity research | Live ANAF PlatitorTvaRest v9 lookup by CUI; lists captured ASF/BVB sources |
| Document extraction | `pdftotext -bbox-layout` on every PDF: each printed field with its page and box |
| Financial reconciliation | Compares every printed field with the recorded tables (≈1,700 per dossier); re-adds the trial balance per account and in total; duplicate accounts; mixed units |
| Cash flow & repayment | DSCR, weakest month, liquidity, leverage, own contribution |
| Credit & fiscal | Credit report, arrears, tax position |
| Legal review | Litigation rules + **Codex** reading the litigation register and draft contract |
| Collateral | Accepted collateral and coverage |
| Policy evaluation | Applies the policy the run was started with; emits the decision |
| Analyst handoff | **Codex** drafts the memo |

When a worker finds an issue it emits a finding with what was observed, what it was compared against, why it matters and its effect, plus evidence: document, page and the exact boxes of the figures involved. The workspace opens the original page (rendered by `pdftoppm`), outlines the problem in red and the comparison in blue, and keeps the map visible with the producing worker highlighted.

### Rules for the model

Numbers and the decision always come from code. Codex runs via `codex exec` under the operator's own ChatGPT sign-in, isolated in the same way as the Baton orchestrator's runtime: user config ignored, no shell, no web, read-only sandbox, empty scratch directory, JSON-schema output. Every quote it returns is located on the page by the engine (unlocated quotes are flagged), and every figure in the memo is checked against the facts it was given. If the model is unavailable the deterministic workers still complete the run. Answer times on a ChatGPT sign-in vary a lot (measured from 5 s to over 4 minutes for the same request); a call that takes longer than `CODEX_TIMEOUT_MS` is dropped and the engine's own text is used, labelled as such.

Subscription sign-in is for local use on the operator's machine. A hosted deployment needs API credentials.

### Workspace, problems, report and Ask

The live run and the completed assessment share one workspace:

- **Map and investigation panel** sized to fit the screen. The panel has four tabs: Evidence (the original page with the problem outlined), Ask, Activity (per worker if you select one on the map) and Sources (ANAF register fields, legal reading points). Each tab scrolls on its own.
- **Policy checks** as tiles that fill in as workers report them: value, requirement and status.
- **Problems, most important first:** blocks decision → fails policy → condition → advisory; within each level, the ones behind the decision come first. Clicking one opens its evidence.
- **Assessment report:** written at handoff by Codex from the run's facts, with every figure checked against them. Without a model, the engine writes it. It can be copied or downloaded as Markdown.
- **Ask:** questions about the run (`POST /api/runs/:id/ask`). Codex answers from the run's facts and the relevant page texts and may point at a finding or quote a line. The engine locates the quote on the page, and the workspace opens it outlined. Figures in answers are checked. Questions and answers are stored per run (`GET /api/runs/:id/questions`), outside the sealed run log. Each answer takes about 40 s. Without a model the panel says so (and why), and the engine answers from the recorded finding: the part the question asks for (why it matters, what would resolve it, which figures, the effect on the decision), never repeating an earlier answer.

### The browser only displays engine results

The policy worker records the full analysis of all four financing scenarios in the run log, and each run stores a digest for the directory. The completed-assessment view, the directory, the review queue and the overview display those recorded results; the browser never evaluates rules. What-if analysis (amount, term, cash-flow stress, cash evidence) is computed by the engine (`POST /api/runs/:id/what-if`) from the run's own recorded observations and policy.

### No answer key at runtime

The dataset's quality labels (`calitate_date.contradictii`, `documente_lipsa`, `monede_normalizate`) and the documents' `probleme` / `status_extragere` notes are never read by the engine or the workspace. `evaluate()` takes an `Observations` argument: missing documents and printed-vs-recorded discrepancies established by a run. The labels and `tests/fixtures/oracle.json` are used only by tests.

## Employees, departments and cases

The workspace opens as **Ioana Marinescu, Legal counsel**. Click your name (bottom left, or the avatar top right) to switch employee; there are no passwords yet, and the browser sends the chosen employee with every request. Employees are added under **Departments**. Every run, question, case event, contact change and sent email records who did it.

- **Departments** (sidebar): Legal, Finance, Credit, Compliance, each with its cases and people. Filter by status or "assigned to me".
- **Send a problem to a department**: every problem, on the assessment page and on the company page, has *Send to …* with the department that usually handles it already chosen (legal review → Legal; identity → Compliance; reconciliation, cash flow, credit and collateral → Finance; missing documents → Credit). A problem already open in a department is not opened twice; its case shows instead.
- **Case page**: the problem with its original page outlined, status (open, in progress, waiting on the company, resolved), assignee, department, and a timeline of comments, changes, drafts, reports and sent emails.
- **Company page**: missing required documents first, with *Upload PDF* (or drop the file on the row); the two assessment actions; the latest problems with *Suggest next steps* and *Draft request for all*; contacts, cases and requests to the company; the full assessment history (every run is kept).
- **Contacts**: the dossier lists representatives without a deliverable address. *Find the published contact* (per company) or *Find contacts* (Companies, every company one at a time) has the assistant search the public web (Codex with web search) for the company's own published address; the engine then opens the page and marks the contact verified only when the address is printed there. The ANAF register adds the official phone. Nothing is guessed.
- **Suggested email, no click needed**: sending a problem to a department starts the assistant on the case: it looks up the contact if none is on file, then writes the suggested email for the employee to review (the case page shows it working).
- **Test delivery (default)**: the companies are real and the contacts the assistant finds are their real addresses, while the applications and staff in this workspace are not. Until someone switches to live delivery (Requests panel, with a confirmation), Send puts a copy in the sender's own Gmail marked `[Test]` with the address it would have gone to.
- **Assistant** (Codex, same isolation as the review workers): drafts a request to the company's representative (English or Romanian) for a case or for all problems, suggests an internal note and a requirement for each problem, and writes case reports. Figures it writes are checked against the facts it was given; without a model the engine writes plain drafts from the recorded findings. Ask also knows the company's contacts and cases.
- **Activity log**: notes, reviews, signatures, scenario checks and routing are stored by the engine, chained per company with SHA-256, and verified in the browser.
- **Run all assessments** (Companies): a new assessment for every company, two at a time with the model (six without; `CREDITDESK_BATCH_CONCURRENCY` changes it). Earlier runs are kept.

## Credit clients and live monitoring

**Companies → Credit clients** lists eleven companies whose financing was approved and drawn (`public/data/clients.json`). They are real listed companies (CUI and register name confirmed in ANAF) with dossiers made by the dataset's own generator in its healthy profile (`python3 scripts/generate-clients.py`); each has a credit line: limit, drawn amount, term, rate, covenants, collateral, relationship manager and review date. They assess Eligible with no problems and can be assessed again at any time; the 50 applications stay applications (Run all covers those).

**Live monitoring** (sidebar) checks every client every `CREDITDESK_MONITOR_MINUTES` (60), one at a time, and on *Check now*:

- **ANAF register, live**: registration status, inactive flag, VAT, name and address, compared with the previous check (deregistration, dissolution, insolvency or inactivity raise an alert).
- **Public news**, in the manner of the AgentResearchFinanciar crawler: a news search for the client's name (Bing News), the pages G4Media, Financial Intelligence and Economica keep for it, and business-news RSS feeds (ZF, Profit.ro, Economica, Financial Intelligence, News.ro, Digi24, Mediafax, G4Media, StartupCafe) are read, articles naming the client are opened only where robots.txt allows (two seconds between requests to a host), kept by SHA-256, and the sentence naming the company is quoted and classified (insolvency, enforcement, investigation → alert; litigation, management change, losses → watch; results, contracts → info). A search engine that answers with a challenge page is not worked around; a page that cannot be read is reported as such.
  Every article found is listed in the client's **News crawler** window (company page); the newest are opened where robots.txt allows, kept by SHA-256 with a snapshot of the page, which opens inside Finra with its scripts off. Risk words in the sentence naming the company (insolvency, enforcement, investigation, litigation, strike, state aid or restructuring, management change, losses) raise a change to review; news older than 90 days is kept for the record only. TAROM, not listed but much in the news, is the client to show this with.
- **Credit line**: covenants (DSCR, debt/EBITDA, liquidity) against the latest completed assessment, re-checked as soon as a new assessment finishes; annual review due within 30 days.
- **Search the web** (on request): the assistant looks for the past year's news; each article is kept only when its quoted sentence is found on the page.

Events stream live into the feed; each can be marked reviewed (recorded in the activity log) or sent to a department as a case.

**Early warning.** A critical signal (insolvency of the client itself, enforcement, an investigation, ANAF declaring it inactive, a covenant breach) shows as a red banner on the client's page, at the top of Today and in Live monitoring. *Review with the assistant* opens the signal with the risk assistant, which reads it against the credit line (drawn, undrawn, collateral, maturity), the latest assessment and the other open signals, writes a risk note and proposes what banks usually do. Each action is the employee's and is recorded: put on the watchlist (amber or red, owner, review date; a case opens in Credit), request information (drafted under the facility's information undertakings, sent as simulated), freeze drawdowns (asked by one employee, in force once a second one approves), run a new assessment, send to Legal. The employee can talk the signal through with the assistant, in the dialog or next to the article in the crawler's reader.

## From application to signed client

The assessment's tabs are a path: Assessment → Financials → Documents → Scenarios → Activity & checks → **Decision**. Each section is marked reviewed (recorded with the employee and the time); the Decision tab is the end of the path and shows what is left: an eligible assessment (always the application as submitted, not a what-if or another scenario), every section reviewed, the analyst's approval recommendation, a **second employee's** credit approval (the engine refuses the analyst who recommended), the contract sent for signature (simulated) and the signature recorded. Signing makes the company a credit client: a credit line is made from the application (limit, term, rate, covenants from the policy, collateral), it moves from Applications to Credit clients, leaves Run all, and live monitoring starts at once.

## Gmail

Requests to companies are sent from each employee's own Gmail, only when the employee presses **Send**. Setup, once per workspace:

1. In Google Cloud Console, create or pick a project and enable the **Gmail API**.
2. Configure the **OAuth consent screen** (External is fine) and add the Gmail addresses that will send as test users. Scopes: `gmail.send`, `openid`, `email`.
3. **Credentials → Create credentials → OAuth client ID → Desktop app**, then download the JSON.
4. Save it as `banking-workspace/.data/google-oauth.json` (or set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`) and restart `npm run dev`.
5. In Finra, click your name → **Connect Gmail**, sign in with Google, and you come back with "Gmail connected".

A Desktop client accepts the `http://127.0.0.1:<port>/api/gmail/callback` redirect on any port. With a *Web application* client instead, register `http://127.0.0.1:5173/api/gmail/callback` (dev) and `http://127.0.0.1:8787/api/gmail/callback` (`npm start`). Refresh tokens stay in the engine database under `.data/` (not in git); *Disconnect* in the same menu revokes them. A sent request is logged on its case and in the company activity log.

## Verification

    npm test              # 37 tests, ~12 s: engine, HTTP API, run stream, departments, cases, requests, Gmail client, credit clients, monitoring; no model, no network
    npm run test:live     # real ANAF and Codex calls end to end (~3 min; needs network and `codex login`)
    npm run test:browser  # headless Chromium (Chrome, Chromium, Brave or Edge; or CHROME_PATH) against the built workspace
    npm run screenshots   # every page, for visual review, into test-results/screens/
    npm run build         # typecheck (src, server, tests) + production bundle

`npm test`:

- All 50 dossiers run through the real engine. Every run completes and every hash chain verifies.
- The scenario outcomes the engine records reproduce **all 200 oracle scenario decisions** and the DSCR, liquidity and leverage metrics.
- Findings match the documented anomalies and are located on the original pages: CONPET's application prints 3,327,500.00 against 3,025,000.00 recorded; COMELF's account 5121 is RON 500.00 off; duplicate account 4111; mixed units. A healthy dossier raises nothing.
- Detection was checked over all 792 PDFs (88,948 printed fields compared): exactly the 8 labelled conflicts, no false positives.
- Memo-figure verification and cancellation are covered.
- Over HTTP (`tests/server.test.ts`, the real engine process): nothing runs when a company is opened; the run stream delivers events as the engine produces them, each exactly once and in order; every worker is shown waiting before it is dispatched and is dispatched only after its dependencies complete; evidence pages render through `pdftoppm` at the proportions the outlined boxes refer to; without a model, Ask restates the recorded finding part by part and does not repeat itself.
- ANAF client: an unknown CUI (v9 answers HTTP 404 with it in `notFound`) is reported as not found, not as an error. Register and dossier names that differ only in legal form or abbreviation ("S.N.G.N. ROMGAZ S.A." / "SOCIETATEA NATIONALA DE GAZE NATURALE ROMGAZ SA") are the same company: checked against the names ANAF returned live for all 50 CUIs, every company matches its own and none matches another's.

`npm run test:live` (last run 28 Oct 2026, `gpt-6.1-sol` medium; details in `test-results/live-summary.json`):
- ANAF v9 lookup of CONPET SA (CUI 1350020): name, registration status and trade register live; an unknown CUI comes back as not found.
- A full CONPET assessment with the model, through the HTTP API and run stream: identity confirmed in ANAF live; the Codex legal reading (≈36 s) and report (≈57 s) are schema-valid, the report cites only real findings and its figures verify; the run takes ≈93 s.
- Ask: "What is the biggest problem?" returns the top-ranked finding with its evidence (≈41 s); asking to see the printed requested amount returns that line located and outlined on the application page (≈47 s).

- People side (`tests/workspace.test.ts`): the Legal employee is the default and others can act or be added; a problem goes to a department once and its case keeps a timeline; contacts; an engine-drafted request that cannot be sent without Gmail; suggestions and case reports; the company activity chain verifies; Gmail sign-in redirects to Google with PKCE and the send-only scope; Run all assesses all 50 companies a few at a time and keeps every run. `tests/gmail.test.ts` checks the RFC 5322 message, the code exchange and the send call against Google's API shapes.

`npm run test:browser` (screenshots in `test-results/browser/`): the company page offers the two actions and nothing runs on open; Run new assessment opens the live run and the map fills from the stream (observed part-way); the first finding opens by itself on its original page with the problem outlined in red and the comparison in blue, every outline inside the page image and the producing worker highlighted; Ask answers and shows which model answered; View assessment opens the completed run; a problem sent to Finance from the assessment appears in Departments and opens as a case with its evidence; the employee can be switched; a missing document is the first thing on the company page. `CREDITDESK_LLM=codex CREDITDESK_ANAF=on npm run test:browser` runs the same with the model and the live register.

Also checked by hand in the browser: run log verified in the browser and by the engine, directory with "Not assessed" states, engine restart marking an interrupted run as failed.

## Source layout

| Path | Responsibility |
|---|---|
| `server/index.ts` | HTTP API, SSE run streams, page rendering, static hosting |
| `server/store.ts` | Runs and hash-chained events (`node:sqlite`) |
| `server/engine/engine.ts` | Start, stream, cancel runs |
| `server/engine/run.ts` | Dependency scheduler, worker context, evidence locators |
| `server/engine/workers.ts` | The ten workers |
| `server/engine/pdf.ts` / `reconcile.ts` | PDF fields with positions; document-vs-record comparison and ledger arithmetic |
| `server/engine/codex.ts` / `anaf.ts` | Codex runtime (after Baton); ANAF client |
| `src/assessment.ts` | Shared event contract, roles and the run fold |
| `src/CompanyEntry.tsx` | Company header, the two actions, real run history |
| `src/AssessmentRun.tsx` | Live run page |
| `src/AssessmentWorkspace.tsx` | Shared workspace: map, investigation panel, checks, ranked problems, report, Ask |
| `server/engine/ask.ts` | Questions about a run, with located answers |
| `src/AssessmentUI.tsx` | Agent map, evidence viewer, finding explanation |
| `src/CompanyDetail.tsx` | Completed assessment: findings, overview, financials, documents, scenarios, audit, contract |
| `src/analysis.ts` | Policy rules and scenario calculations |
| `src/Portfolio.tsx`, `src/App.tsx` | Directory, overview, policy, workspace audit; routing |
| `server/workspace.ts`, `server/workspace-api.ts` | Employees, cases and their timelines, contacts, requests, Gmail connections, company activity log; their HTTP routes |
| `server/engine/agent.ts` | The assistant's request drafts, per-problem suggestions and case reports |
| `server/engine/batch.ts` | Run all assessments, a few at a time |
| `server/gmail.ts` | Google OAuth (PKCE) and sending through the Gmail API |
| `src/workspace.ts`, `src/people.ts` | Shared contract for departments, cases, contacts and requests; browser client and session |
| `src/Departments.tsx`, `src/Requests.tsx` | Departments, case page, send-to-department; contacts, request drafts and sending |
| `src/DossierDocuments.tsx` | Missing-document alert, document list, uploads |
| `server/engine/monitor.ts`, `src/LiveMonitoring.tsx`, `src/monitoring.ts` | Monitoring checks and feed; Credit clients table, Live monitoring page, client panel; shared contract |
| `server/engine/contacts.ts`, `scripts/generate-clients.py` | Public contact research with page check; the ten credit clients |
| `tests/*.test.ts` | Deterministic suite: engine over all 50 dossiers, HTTP API and run stream, ANAF client |
| `tests/live/`, `tests/browser/` | Live ANAF + Codex end to end; headless browser over the DevTools protocol (no extra dependency) |

## Scope

Company names and CUIs are public identity references; the financial, legal and banking data in the dataset is fabricated, and the credit policy (`POL-CL-2026`) carries the dataset's thresholds. Notes, reviews, recorded signatures, cases and requests are stored by the engine. Employees are chosen in the browser without passwords: the engine is a single local process without authentication, for a trusted local network.
