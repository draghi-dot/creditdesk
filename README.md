# CreditDesk

Internal corporate-banking workspace for reviewing 50 company financing applications. A React + TypeScript + Vite workspace backed by a local **assessment engine** (Node 25, no framework) that runs real review workers over each dossier's original PDFs.

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
| `CREDITDESK_ANAF` | on | `off` skips the live ANAF lookup (tests use this) |

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

Numbers and the decision always come from code. Codex runs via `codex exec` under the operator's own ChatGPT sign-in, isolated in the same way as the Baton orchestrator's runtime: user config ignored, no shell, no web, read-only sandbox, empty scratch directory, JSON-schema output. Every quote it returns is located on the page by the engine (unlocated quotes are flagged), and every figure in the memo is checked against the facts it was given. If the model is unavailable the deterministic workers still complete the run.

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

## Verification

    npm test              # 21 tests, ~9 s: engine, HTTP API and run stream; no model, no network
    npm run test:live     # real ANAF and Codex calls end to end (~3 min; needs network and `codex login`)
    npm run test:browser  # headless Chromium (Chrome, Chromium, Brave or Edge; or CHROME_PATH) against the built workspace
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

`npm run test:browser` (screenshots in `test-results/browser/`): the company page offers the two actions and nothing runs on open; Run new assessment opens the live run and the map fills from the stream (observed part-way); the first finding opens by itself on its original page with the problem outlined in red and the comparison in blue, every outline inside the page image and the producing worker highlighted; Ask answers and shows which model answered; View assessment opens the completed run. `CREDITDESK_LLM=codex CREDITDESK_ANAF=on npm run test:browser` runs the same with the model and the live register.

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
| `tests/*.test.ts` | Deterministic suite: engine over all 50 dossiers, HTTP API and run stream, ANAF client |
| `tests/live/`, `tests/browser/` | Live ANAF + Codex end to end; headless browser over the DevTools protocol (no extra dependency) |

## Scope

Company names and CUIs are public identity references; all financial, legal and banking data is fabricated, and the policy is a demonstration policy. Analyst notes and the signing simulation remain local to the browser. The engine is a single local process without authentication.
