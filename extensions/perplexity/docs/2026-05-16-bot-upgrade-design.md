# Perplexity Bot Upgrade — Design Spec

**Date** : 2026-05-16
**Status** : Design approved, ready for implementation plan

## Goal

Upgrade the OpenClaw Perplexity extension (currently a 729-line web search wrapper around `sonar-pro`) to add three load-bearing capabilities :

1. **Auto model switching** — pick the right Perplexity model based on the query (`sonar-pro` / `sonar-reasoning` / `sonar-deep-research`)
2. **Computer mode** — delegate complex agent tasks to Perplexity Computer (beta) via Chrome MCP, using the user's logged-in session (2000 free credits available)
3. **Reminders / scheduled tasks** — schedule recurring or one-shot Perplexity queries with persistence + Telegram notification

## Current state

- File : `extensions/perplexity/src/perplexity-web-search-provider.ts` (729 lines)
- Single model hardcoded : `DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro"`
- Supports OpenRouter or direct Perplexity API via `baseUrl`
- Citation extraction + retry logic
- No model dispatch, no Computer mode, no scheduling, no persistence

## Approach — selected (after trade-off analysis)

### 1. Model switching : keyword heuristic (option A)

A small `inferModelFromQuery()` function applies FR + EN keyword rules :

| Keywords                                                                                              | Model                 |
| ----------------------------------------------------------------------------------------------------- | --------------------- |
| `["deep research", "exhaustive", "comprehensive", "in-depth", "rapport complet", "audit complet"]`    | `sonar-deep-research` |
| `["why", "how", "explain", "step by step", "analyse", "pourquoi", "comment", "explique", "raisonne"]` | `sonar-reasoning`     |
| query length > 200 chars + question mark                                                              | `sonar-reasoning`     |
| (default)                                                                                             | `sonar-pro`           |

Explicit override always wins : `model: 'reasoning'` param bypasses the heuristic.

**Rationale** : zero latency, deterministic, easy to test. Migrate to an LLM classifier (option B, Gemini Flash) only if production usage shows >20% misclassification.

### 2. Computer mode via Chrome MCP

Perplexity Computer (`perplexity.ai/computer`) has no public API as of 2026-05-16. We use the `claude-in-chrome` MCP to drive the user's logged-in Chrome session.

**Flow** :

```
caller → perplexity.search(query, opts)
          ↓
       isComputerTask(query, opts) ?
          ├─ yes → ComputerProvider
          │         1. tabs_create_mcp("https://perplexity.ai/computer")
          │         2. type_text(query) into textarea
          │         3. shortcut Enter
          │         4. poll get_page_text every 5s until "completed" marker
          │         5. read_page → extract artifact / answer
          │         6. return { result, source: "computer", creditsUsed }
          └─ no  → existing API provider (Sonar via baseUrl)
```

**Detection `isComputerTask(query, opts)`** :

- explicit `opts.mode === "computer"` → true
- query starts with `["build", "create a website", "develop", "design a dashboard", "analyze and report on", "construis", "crée un site", "développe", "audit complet"]` → true
- otherwise false

**Risks identified** :

- DOM polling fragile if Perplexity UI changes → version-detect at startup, log warning
- 2000-credit quota → monitor usage, fail-fast with explicit error when exhausted
- No API fallback if Computer service down → return clear error, caller can retry with `mode: "sonar"`

### 3. Reminders / scheduled tasks

**Storage** : SQLite via `better-sqlite3` (already a dependency of OpenClaw runtime) — single file `~/.openclaw/perplexity/reminders.db`.

**Schema** :

```sql
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,           -- nanoid
  user_id TEXT NOT NULL,         -- OpenClaw user
  query TEXT NOT NULL,
  cron TEXT,                     -- null = one-shot, else cron expression
  model TEXT,                    -- null = auto-detect
  mode TEXT,                     -- null = auto, 'sonar' | 'computer'
  next_run_at INTEGER NOT NULL,  -- unix seconds
  last_run_at INTEGER,
  last_result TEXT,              -- JSON
  status TEXT NOT NULL,          -- 'active' | 'paused' | 'cancelled' | 'done'
  notify_channel TEXT,           -- 'telegram' | 'webhook' | null
  notify_target TEXT,            -- chat_id or url
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_next_run ON reminders(next_run_at, status);
```

**Scheduler** : in-process `node-cron` listener iterating active reminders every 60 s. Lighter than a separate daemon. Started on plugin init, stopped on dispose.

**Notification** : when a reminder fires, if `notify_channel = 'telegram'`, POST to a `TELEGRAM_BOT_URL` env (existing REX bot for Kevin). Otherwise, store `last_result` only — caller can poll `listReminders()`.

**Public methods on the provider** :

```ts
remind(opts: { query: string; cron?: string; runAt?: number; model?: string; mode?: 'sonar' | 'computer'; notify?: { channel: 'telegram'; target: string } }): Promise<{ id: string }>
listReminders(filter?: { status?: ReminderStatus }): Promise<Reminder[]>
cancelReminder(id: string): Promise<void>
pauseReminder(id: string): Promise<void>
resumeReminder(id: string): Promise<void>
```

## File structure (after upgrade)

```
extensions/perplexity/
├── docs/
│   └── 2026-05-16-bot-upgrade-design.md            # this file
├── src/
│   ├── perplexity-web-search-provider.ts           # existing — adds inferModelFromQuery + computer fallback wiring
│   ├── perplexity-model-router.ts                  # NEW — keyword heuristic, ~80 lines
│   ├── perplexity-computer-provider.ts             # NEW — Chrome MCP driver, ~200 lines
│   ├── perplexity-reminder-store.ts                # NEW — SQLite CRUD + migrations, ~150 lines
│   ├── perplexity-scheduler.ts                     # NEW — node-cron loop + fire logic, ~120 lines
│   └── perplexity-notifier.ts                      # NEW — telegram / webhook dispatch, ~60 lines
├── index.ts                                        # existing — export new methods on plugin
├── openclaw.plugin.json                            # update configSchema with reminder/computer options
└── package.json                                    # add better-sqlite3 + node-cron deps
```

## Invariants

1. **Backwards compat** : existing callers of `searchTool({ query })` keep working unchanged (default model = `sonar-pro`, no Computer, no reminder).
2. **Idempotent reminders** : same `(query, cron, user_id)` tuple is deduplicated at insert.
3. **Quota safety** : Computer mode fails fast when monthly credits exhausted ; never silently downgrades.
4. **No race conditions** : scheduler uses SELECT FOR UPDATE-equivalent on SQLite (BEGIN IMMEDIATE).
5. **Test coverage** : `inferModelFromQuery` 100 % line coverage with table-driven tests.

## Out of scope (deferred)

- Multi-user reminders (only the OpenClaw `user_id` of the caller for now)
- Web UI for reminder management (CLI/API only ; UI lives in REX dashboard later)
- Migration from in-process scheduler to external worker (only if scale demands)
- LLM-based query classifier (only if heuristic <80 % accuracy in prod)

## Open questions (resolved)

| Question                        | Decision (Kevin, 2026-05-16)                     |
| ------------------------------- | ------------------------------------------------ |
| Model switching strategy        | A — keyword heuristic                            |
| Computer mode integration       | Chrome MCP via user's logged-in session          |
| Reminder storage                | Local SQLite + in-process node-cron              |
| Reminder notification           | Telegram via existing REX bot (channel optional) |
| Computer mode UI version-detect | Yes, on startup, log warning if changed          |

## Verification gates

Before merging :

1. `pnpm test extensions/perplexity` — all green (heuristic tests, scheduler unit tests, SQLite store tests)
2. Smoke test : `searchTool({ query: "Explique pourquoi React 19 préfère server components" })` → uses `sonar-reasoning`
3. Smoke test : `searchTool({ query: "Crée un site web pour ma boulangerie" })` → triggers Computer mode (manual : confirm Chrome opens Perplexity Computer)
4. Smoke test : `remind({ query: "Trends AI", cron: "0 9 * * *", notify: { channel: 'telegram', target: 'KEVIN_CHAT_ID' } })` → reminder created, fires next 9:00, message arrives in Telegram

## Risks & mitigation

| Risk                                                      | Mitigation                                                                                            |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Perplexity Computer UI changes break polling              | Version-detect at startup ; log warning ; one canary test before each prod use                        |
| 2000 credits run out faster than expected                 | Track per-call cost in DB ; expose `getQuotaRemaining()` ; alert at 90 %                              |
| SQLite file corruption                                    | Daily backup to `~/.openclaw/perplexity/backups/YYYY-MM-DD.db` (kept 7 days)                          |
| Scheduler missing a fire (process down at scheduled time) | On startup, scan reminders with `next_run_at < now AND status='active'` → fire immediately (catch-up) |
| Heuristic mismatch for FR vs EN queries                   | Maintain both keyword lists ; community-contributed extensions via JSON config                        |

## Effort estimate

| Phase                         | Effort | Cumul |
| ----------------------------- | ------ | ----- |
| 1. Model router               | 1-2 h  | 2 h   |
| 2. Computer provider          | 3-4 h  | 6 h   |
| 3. Reminder store + scheduler | 4-6 h  | 12 h  |
| 4. Notifier (Telegram)        | 1 h    | 13 h  |
| 5. Integration + smoke tests  | 2 h    | 15 h  |

**Total** : 9-15 h. Realistic 2-3 sessions.

## Next step

After this design is approved → `superpowers:writing-plans` produces a step-by-step implementation plan in `docs/superpowers/plans/2026-05-16-perplexity-bot-upgrade.md`.
