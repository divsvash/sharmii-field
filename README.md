# Shramii Field

An offline-first field attendance & incident reporting app for React Native
(Expo), built as a durable local-first architecture with a small,
independently-tested synchronization engine on top.

## Problem

Field workers (site guards, inspectors) punch in/out and file incident
reports from locations with unreliable or absent connectivity. The app
must let them keep working — recording punches, incidents, and photos —
whether or not the device can currently reach the server, and must
guarantee that nothing recorded locally is ever silently lost, duplicated,
or synced out of order once connectivity returns.

## Architecture

```
UI (App.tsx / src/app/DemoScreen.tsx)
   |
Domain (src/domain/attendance, src/domain/incident, src/domain/sync)
   |
SQLite (src/data/db — punches, incidents, incident_photos, outbox_items)
   |
Outbox (outbox_items table — the durable queue of pending server writes)
   |
SyncEngine (src/domain/sync/SyncEngine.ts — one synchronization pass)
   |
Transport (src/data/api/HttpSyncTransport.ts — real fetch, or a fake in tests)
```

More concretely, the sync path a single outbox item travels:

```
OutboxRepository.listAll()
      |
OutboxDispatchSelector.selectEligibleOutboxItems()   -- dependency + retry-window filtering
      |
OutboxDispatcher.dispatchOutboxItem()                -- claim, send, classify, persist
      |                    |
OutboxDispatchStore   SyncTransport
(conditional claim,   (HTTP in production,
 mark synced/failed)   fake/mock in tests)
      |                    |
SqliteOutboxDispatchStore  HttpSyncTransport -> real API (production)
                                             -> MockApiServer (integration tests)
```

`SyncEngine.runOnce()` orchestrates one full pass: recover abandoned
`IN_FLIGHT` work, load the outbox, select eligible items, dispatch them
sequentially, and repeat until nothing new becomes eligible. It has no
timer of its own — something else (a UI button, a connectivity listener via
`src/domain/sync/SyncTrigger.ts`) decides when to call it.

### Directory structure

```
src/
├── app/            DemoScreen.tsx — the one demo screen (see Phase 6 below)
├── domain/
│   ├── attendance/  Punch type + validation, PunchRepository interface
│   ├── incident/    Incident/IncidentPhoto types + validation, repository interfaces
│   └── sync/        OutboxItem, SyncError, SyncFailureClassifier, RetryPolicy,
│                     OutboxDispatchSelector, OutboxDispatcher, OutboxDispatchStore,
│                     SyncTransport, SyncEngine, SyncTrigger
├── data/
│   ├── api/         HttpSyncTransport — the production SyncTransport (real fetch)
│   ├── db/          SQLite port (SqlDatabase), migrations, concrete repositories
│   └── secure/      (empty — no auth in this app)
├── features/         (empty — no additional screens beyond the demo)
├── navigation/        (empty — single screen, no router needed)
├── i18n/              (empty)
└── shared/            filesystemPath.ts
```
`App.tsx` (repo root) is the Expo entrypoint, rendering `DemoScreen`.

## Key guarantees

- **Offline writes are durable before the UI treats them as queued** —
  `AtomicOutboxWriter`/`SqliteAtomicOutboxWriter` commit the entity row and
  its outbox row in one transaction; the promise only resolves after
  `COMMIT`.
- **Entity + outbox write is atomic** — either both rows exist, or neither
  does. Proven with a real rollback test (see Testing below).
- **Idempotency keys survive retries** — `OutboxItem.idempotencyKey` is
  read once and passed unchanged on every dispatch attempt; nothing
  regenerates it. Proven at the dispatcher, HTTP transport, and full-stack
  levels.
- **Dependency ordering is enforced** — a punch-out cannot sync before its
  punch-in, an incident photo cannot sync before its incident.
  `OutboxDispatchSelector` excludes a dependent until its prerequisite
  reaches `SYNCED`, and permanently excludes it if the prerequisite fails
  terminally (without inventing a new persisted status for that case).
- **Retryable and terminal failures are distinguished** — `SyncError` is a
  discriminated union (`kind: 'retryable' | 'terminal'`), classified once
  by `SyncFailureClassifier` from a normalized `SyncFailureSignal` (HTTP
  status, network error, or application-level rejection). No other module
  re-implements this classification — `HttpSyncTransport` explicitly never
  classifies, it only normalizes.
- **Retry timing is persisted, not invented per-run** — a retryable
  failure computes `nextAttemptAt` via `RetryPolicy.nextDelayMs()` (bounded
  exponential backoff, deterministic, no `setTimeout`) and persists it;
  `OutboxDispatchSelector` will not re-select the item until that time has
  elapsed.
- **Abandoned in-flight work is recovered** — any outbox item left
  `IN_FLIGHT` when the app restarts (or when `SyncEngine.runOnce()` starts)
  is moved to `FAILED_RETRYABLE`. Safe specifically because of the
  idempotency-key guarantee above — retrying an uncertain request cannot
  double-apply it server-side.
- **Conditional claims prevent duplicate dispatch** — `tryClaim` is a
  single `UPDATE ... WHERE status IN ('PENDING','FAILED_RETRYABLE')`; the
  database, not application code, performs the conditional transition.
  `changes === 1` means this call claimed it, `changes === 0` means someone
  else already has.
- **Recovery distinguishes "abandoned" from "still busy"** —
  `recoverInFlightItems(staleAfterMs)` only reclaims an `IN_FLIGHT` row
  once it has sat unclaimed-looking for at least `staleAfterMs`.
  `SyncEngine.runOnce()` passes `DEFAULT_RECOVERY_STALE_AFTER_MS` (60s,
  double `HttpSyncTransport`'s own default 30s request timeout) so a
  second, overlapping `runOnce()` call cannot reclaim and re-dispatch an
  item a still-live sibling call is genuinely working on. Cold-start
  recovery (`openDatabase.ts`) still passes no threshold (recovers
  unconditionally) — correct there because nothing else can hold a live
  claim the instant a process starts. See "Known limitations" for what
  this threshold does and doesn't guarantee.

## Testing

Two tiers:

- **Pure unit tests** (`__tests__/domain/**`, `__tests__/shared/**`,
  `__tests__/data/api/**`) — no I/O, run under plain Node.
- **Integration tests** (`__tests__/integration/**`) — run the actual
  production classes against real infrastructure: a real embedded SQLite
  engine (Node's built-in `node:sqlite`, via
  `__tests__/helpers/NodeSqliteTestDatabase.ts`, behind the same
  `SqlDatabase` port `ExpoSqlDatabase` implements for production), and a
  real HTTP server (`__tests__/helpers/MockApiServer.ts` — Node's built-in
  `http` module, no framework) reached over a real socket via `fetch`.

As of this writing: **218 tests passing** as of the initial submission;
additional tests were added for retry-limit enforcement and the
recovery/concurrency fix described in "Known limitations" below, so the
current count is higher — run `npm test` for the exact, current number
rather than trusting this figure. `tsc --noEmit` clean on both the
domain/data/test tsconfig and the separate app-shell tsconfig (see
`tsconfig.app.json`).

### Sabotage testing

At several points during development, specific guarantees were verified by
**deliberately breaking the implementation, confirming the relevant test(s)
failed, then restoring the correct code and re-confirming the suite passed
again.** This is a spot-check that a given test is a real safety net for a
given defect — not formal verification, not exhaustive, not a substitute
for code review or a real device test pass. Sabotage checks performed
during development (each restored immediately afterward):

- **Transaction atomicity** — removed the `withTransactionAsync` wrapper
  from `SqliteAtomicOutboxWriter`; the rollback-proof integration test
  failed as expected (an orphaned punch row survived a failed transaction).
- **Foreign-key enforcement** — reproduced the exact historical bug (FK
  enforcement defaulting off, `PRAGMA foreign_keys = ON` buried inside a
  migration's transaction where SQLite treats it as a no-op); the FK
  regression tests correctly failed under that reproduction.
- **Conditional claim predicate** — replaced `tryClaim`'s conditional
  `UPDATE ... WHERE status IN (...)` with an unconditional one; 6 of 12
  `SqliteOutboxDispatchStore` integration tests failed, including the
  two-worker race test.
- **Loop termination** — removed the `attemptedIds` filter from
  `SyncEngine.runOnce()`'s dispatch loop; the "does not loop forever" test
  genuinely hung and was killed by a `timeout` wrapper (exit code 124),
  confirming it wasn't a vacuous assertion.

## Known limitations

Stated plainly, not minimized:

- **Test SQLite engine vs. production SQLite engine.** All SQLite
  integration tests run against Node's built-in `node:sqlite`, not
  `expo-sqlite`'s native binding — `expo-sqlite` cannot load in a plain
  Node process, and no Android/iOS build environment exists in this
  sandbox. Both are wrapped behind the same `SqlDatabase` port and execute
  the same production repository/dispatcher/engine code, but `SqlDatabase`
  only captures their common subset — a genuine `expo-sqlite`-specific
  behavioral quirk outside that subset would not be caught here. Notably,
  during Phase 1 development, `node:sqlite` was found to default foreign-key
  enforcement to **ON** (unlike standard SQLite/`expo-sqlite`, which
  default **OFF**) — this had to be explicitly worked around to write a
  faithful sabotage test (see above). An on-device smoke test remains
  advisable before shipping.
- **No native Android/iOS build was performed or verified.** This sandbox
  has no Android SDK, emulator, or `adb`. The closest available check,
  `npx expo-doctor --verbose`, was run in an earlier phase and passed
  19/21 checks (the 2 failures were network-restricted, not project
  defects). No claim is made here that a native build succeeds — only
  that dependency/config validation passed as far as it could run.
- **The demo screen (`App.tsx`, `src/app/DemoScreen.tsx`) was never
  rendered or run.** No Metro bundler or RN emulator is available in this
  sandbox. It was statically typechecked (via `tsconfig.app.json`, kept
  separate from the main domain/test tsconfig so RN's type-resolution
  needs never affect the load-bearing verification path) and reviewed, but
  not executed. It has no automated tests.
- **`recoverInFlightItems()`'s staleness threshold is a heuristic, not a
  lease.** It correctly distinguishes "abandoned" from "claimed a moment
  ago" using elapsed wall-clock time, but there is still no lease,
  heartbeat, or owner-identity concept — a genuinely-hung request that
  somehow outlives both `HttpSyncTransport`'s own 30s timeout and the 60s
  recovery threshold (e.g. a transport bug that fails to honor its
  `AbortController`) would eventually be reclaimed and re-dispatched by a
  later call, same as before this fix. The threshold shrinks the race
  window from "always" to "an unrealistic double-failure," it doesn't
  eliminate the underlying assumption that a claim which outlives the
  threshold is dead. A real lease/expiry/heartbeat mechanism would close
  this fully; deliberately out of scope per the "no scheduler service"
  constraint. Proven (both the fixed common case and the still-open
  genuinely-stale case) in `SyncEngine.fullstack.integration.test.ts`.
- **`OutboxRepository.listSyncable()` does not honor the retry-window
  gating (`nextAttemptAt`)** that `OutboxDispatchSelector` added in Phase
  1. `SyncEngine` never calls `listSyncable()` (it uses `listAll()` +
  the selector), so this is inert in the current production path, but the
  method remains part of the public interface and is inconsistent with the
  selector's newer behavior. Left as-is rather than expanding this
  sprint's scope.
- **No automatic retry scheduling across app restarts/idle periods.**
  `nextAttemptAt` is persisted and enforced at selection time, but nothing
  calls `SyncEngine.runOnce()` on a timer or schedule — that's a deliberate
  choice (`SyncTrigger`'s doc comment says so explicitly) per the "no
  scheduler service, no timers in the engine" constraint. A caller (a
  connectivity listener, a manual button, a platform background-task API)
  must decide when to call `syncNow()`.
- **`ConnectivityListener` has no real implementation.** Only the
  interface and the wiring function (`wireConnectivityToSyncTrigger`)
  exist; no React Native `NetInfo` or browser `online`-event adapter was
  built, per the "keep connectivity behind a tiny interface, don't
  implement Android background execution" constraint.
- **`wireConnectivityToSyncTrigger` does not guard against overlapping
  `syncNow()` calls** if connectivity flaps rapidly. Documented in the
  source rather than solved — solving it would mean adding a queue/lock,
  which the "no scheduler service" constraint rules out for this sprint.
- **`HttpSyncTransport`'s network-failure signal is coarse.** Any
  non-timeout `fetch` rejection (DNS failure, connection refused, TLS
  error, offline, etc.) is bucketed as a single `NETWORK_UNREACHABLE`-style
  signal — `fetch` provides no portable, structured way to distinguish
  these further.
- **`npm audit --omit=dev` reports vulnerabilities** in the dependency
  tree (see the audit output in the final verification report) — all
  transitive from `expo`/`@expo/prebuild-config` tooling, not introduced by
  this project's own code, and not something this sprint attempted to
  resolve.
- **No authentication.** Not required by anything built so far; the demo
  screen uses a hardcoded `demo-employee`/`demo-site`.
- **No camera/GPS integration.** `DemoScreen` uses hardcoded placeholder
  coordinates and a placeholder selfie path — device sensor integration
  was out of scope for "the smallest useful demo".

## Commands

```bash
npm run typecheck              # tsc --noEmit — domain/data/test code (strict)
npx tsc --noEmit -p tsconfig.app.json   # separate typecheck for the demo UI (App.tsx, src/app/**)
npm test                       # jest — unit + real-SQLite + real-HTTP integration tests
npm audit --omit=dev           # dependency vulnerability check
```
