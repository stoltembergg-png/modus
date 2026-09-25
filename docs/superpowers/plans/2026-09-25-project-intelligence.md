# Project Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` task-by-task under the Orchestrator's delegated phase workflow. Steps use checkbox syntax. Do not commit unless the user explicitly asks.

**Goal:** Add trustworthy, local-first global/project memory that is stored in SQLite, retrieved before new agent turns, and managed in Settings.

**Architecture:** SQLite in Electron main is authoritative for concise memories, their scope, temporal state, and evidence links. A main-process Project Memory service and Context Planner connect the current agent tool/runtime lifecycle to the existing `PiSdkRuntime.composeTurnMessage()` path; CodeGraph/Fast Codebase contributes optional file/symbol evidence but is never a synchronous turn dependency. The renderer receives only typed, bounded DTOs through sender-validated IPC.

**Tech Stack:** Electron main/preload IPC, TypeScript shared contracts, `node:sqlite` `DatabaseSync`, TypeBox agent tools, Zod IPC schemas, React Settings UI, Vitest, existing CodeGraph/Fast Codebase CLI.

**Spec:** `docs/superpowers/specs/2026-09-25-project-intelligence-design.md`

## Global Constraints

- SQLite remains the sole authoritative memory store; memories are project-scoped or global.
- Inbox/no-project turns use global memory only. Global records are limited to cross-project preferences/conventions; project code facts remain scoped to a real `workspace_id`.
- Memory is enabled by default; Settings must allow pausing global/project memory and inspecting, obsoleting, verifying provisional items, and deleting records.
- Store concise claims and structured evidence, not transcripts or copied source files.
- The agent proposes memories through its current run; no extra model call is made to extract or consolidate memories.
- Only relevant, evidence-backed records become active automatically after run completion. Preserve failed attempts with an explicit failed-attempt category; never word them as successful solutions.
- Worktree/subagent discoveries stay provisional until verified in the parent checkout or integrated.
- Retrieve before each new turn with a strict 1,200-token estimated budget. Never block prompt submission on CodeGraph initialization/sync, network, or external services.
- Memory text is lower-trust evidence, not system/developer instructions. It must not be inserted into privileged prompt roles.
- Context7, GitHub Code Search/gh-grep, embeddings, and graph visualization are interfaces/future work only; V1 adds no external integration or embedding dependency.
- Use TDD: write a failing focused test, run RED, implement the minimum, then GREEN. Do not commit unless explicitly asked.
- Keep the existing open PR #30 on `feat/provider-limits` untouched. Work only on `feat/project-intelligence`.

## File Structure

- `apps/desktop/src/shared/contracts.ts`: public memory scope/status/category/evidence and IPC DTO types.
- `apps/desktop/src/main/db/database.ts`: additive SQLite schema/index migration for memory records, evidence, lifecycle events, and scope settings.
- `apps/desktop/src/main/memory/project-memory-service.ts`: scoped CRUD, proposal validation, lifecycle transitions, deletion/rollback helpers, settings, and bounded queries.
- `apps/desktop/src/main/memory/project-memory-service.test.ts`: migration, persistence, scope isolation, state transitions, deletion, and rollback tests using a temporary SQLite file.
- `apps/desktop/src/main/context/context-planner.ts`: typed candidate-source contract, relevance ranking, citations, budget packing, and graceful fallbacks.
- `apps/desktop/src/main/context/context-planner.test.ts`: deterministic ranking/budget/scope tests with fake Git and code-location inputs.
- `apps/desktop/src/main/agent/tools/project-memory-tools.ts`: current-run `project_memory_propose` tool and registration metadata.
- `apps/desktop/src/main/agent/tools/project-memory-tools.test.ts`: tool-context ownership, proposal validation, and no cross-scope writes.
- `apps/desktop/src/main/agent/pi-sdk-runtime.ts`: register the tool, retrieve/format a memory digest in `composeTurnMessage()`, finalize candidates on authoritative run/compaction hooks, and include provisional child discoveries at the existing wait/harvest boundary.
- `apps/desktop/src/main/agent/rollback-service.ts`, `session-lifecycle.ts`: mark memories from rolled-back runs for review and detach evidence when chats are deleted/archived as specified.
- `apps/desktop/src/main/ipc/channels.ts`, `schemas.ts`, `register-app-ipc.ts`, plus `project-memory-ipc.ts`: validated, sender-checked memory manager API.
- `apps/desktop/src/main/ipc/project-memory-ipc.test.ts`: schema, sender, workspace-scope, and handler behavior tests.
- `apps/desktop/src/preload/types.ts`, `index.ts`: typed `window.modus.projectMemory` API.
- `apps/desktop/src/renderer/src/features/settings/SettingsPanel.tsx`: minimal project/global memory manager section using existing Settings visual patterns.
- `apps/desktop/src/renderer/src/features/settings/projectMemory.test.ts`: memory status labels, scope grouping, and action-state formatting tests using existing renderer test conventions.

## Shared Interfaces

Add the following types in `apps/desktop/src/shared/contracts.ts` before using them in service, IPC, or UI code:

```ts
export type ProjectMemoryScope =
  | { kind: "global" }
  | { kind: "project"; workspaceId: string };

export type ProjectMemoryCategory =
  | "decision"
  | "architecture"
  | "convention"
  | "constraint"
  | "known_issue"
  | "solution"
  | "failed_attempt"
  | "task_result"
  | "preference";

export type ProjectMemoryStatus =
  | "candidate"
  | "active"
  | "provisional"
  | "needs_review"
  | "superseded"
  | "obsolete";

export type ProjectMemoryVerification =
  | "user_explicit"
  | "agent_observed"
  | "tests_passed"
  | "parent_verified"
  | "unverified";

export type ProjectMemoryEvidence = {
  kind: "user_message" | "run" | "task" | "subagent" | "commit" | "file" | "symbol";
  sessionId?: string;
  runId?: string;
  userMessageId?: string;
  taskRef?: string;
  commitSha?: string;
  branch?: string;
  path?: string;
  symbol?: string;
  detached?: boolean;
};

export type ProjectMemoryRecord = {
  id: string;
  scope: ProjectMemoryScope;
  category: ProjectMemoryCategory;
  title: string;
  claim: string;
  status: ProjectMemoryStatus;
  verification: ProjectMemoryVerification;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string;
  supersedesId?: string;
  evidence: ProjectMemoryEvidence[];
};

export type ProjectMemorySnapshot = {
  globalEnabled: boolean;
  projectEnabled: boolean;
  memories: ProjectMemoryRecord[];
};

export type ProjectMemoryDigest = {
  text: string;
  memoryIds: string[];
  estimatedTokens: number;
};
```

Add these exact typed preload methods under `window.modus.projectMemory`:

```ts
snapshot(input: { workspaceId?: string }): Promise<ProjectMemorySnapshot>;
setEnabled(input: { scope: ProjectMemoryScope; enabled: boolean }): Promise<ProjectMemorySnapshot>;
verify(input: { memoryId: string }): Promise<ProjectMemorySnapshot>;
markObsolete(input: { memoryId: string }): Promise<ProjectMemorySnapshot>;
delete(input: { memoryId: string }): Promise<ProjectMemorySnapshot>;
```

The current-project ID is sent only for Settings display/query and must be checked against the
workspace table in main. Agent memory writes do not accept a renderer-supplied workspace/session/run
ID; they derive ownership from `AgentToolContext` and `getActiveAgentRun()`.

Define these service interfaces in `project-memory-service.ts`:

```ts
export type ProjectMemoryProposalInput = {
  scope: "global" | "project";
  category: ProjectMemoryCategory;
  title: string;
  claim: string;
  evidence: ProjectMemoryEvidence[];
  supersedesId?: string;
};

export type ProjectMemoryContext = {
  workspaceId: string;
  sessionId: string;
  runId: string;
  userMessageId?: string;
  cwd: string;
  parentSessionId?: string;
  subagentWorktree?: boolean;
};

export type ProjectMemoryRetrievalInput = {
  workspaceId?: string;
  inbox: boolean;
  query: string;
  contextPaths: string[];
  contextSymbols: string[];
  git: { branch?: string; head?: string; changedPaths: string[] };
  tokenBudget?: number;
};

export function proposeProjectMemory(
  input: ProjectMemoryProposalInput,
  context: ProjectMemoryContext,
): ProjectMemoryRecord;
export function finalizeProjectMemoryRun(input: {
  sessionId: string;
  runId: string;
  outcome: "completed" | "failed" | "cancelled";
}): void;
export function recordProjectMemoryCompaction(input: {
  sessionId: string;
  runId: string;
  aborted: boolean;
  willRetry: boolean;
}): void;
export function retrieveProjectMemory(
  input: ProjectMemoryRetrievalInput,
): ProjectMemoryDigest;
export function getProjectMemorySnapshot(workspaceId?: string): ProjectMemorySnapshot;
export function setProjectMemoryEnabled(input: {
  scope: ProjectMemoryScope;
  enabled: boolean;
}): ProjectMemorySnapshot;
export function verifyProjectMemory(memoryId: string): ProjectMemorySnapshot;
export function markProjectMemoryObsolete(memoryId: string): ProjectMemorySnapshot;
export function deleteProjectMemory(memoryId: string): ProjectMemorySnapshot;
export function detachProjectMemoryEvidenceForSession(sessionId: string): void;
export function invalidateProjectMemoriesForRuns(sessionId: string, runIds: string[]): void;
```

`retrieveProjectMemory()` returns only `active`, applicable records. Inbox is identified by
`CHATS_WORKSPACE_ID` (or absent workspace) and retrieves global records only. Project turns retrieve
global plus the matching workspace records. `ProjectMemoryDigest.estimatedTokens` must never exceed
the requested budget (default 1,200).

---

## Phase 1 — SQLite persistence and temporal semantics

### Task 1: Add the memory schema and shared DTOs

**Files:**
- Modify: `apps/desktop/src/shared/contracts.ts`
- Modify: `apps/desktop/src/main/db/database.ts`
- Create: `apps/desktop/src/main/memory/project-memory-service.test.ts`

**Interfaces:**
- Define the shared types above.
- Add idempotent tables/indexes in the existing `migrate(db)` function; do not add another database file.
- Use `project_memory_records`, `project_memory_evidence`, `project_memory_events`, and
  `project_memory_settings` as the SQL table names.

- [ ] **Step 1: Write RED migration tests.** Mock `electron.app.getPath()` to a temporary directory.
  Before importing `database.ts`, create `userData/modus.sqlite` with `DatabaseSync`, seed the
  existing `workspaces` and `agent_sessions` tables with one row each, then close the seed
  connection. Dynamically import `getDatabase()` and assert migration preserves those rows and adds
  all four memory tables/indexes. Assert SQLite CHECK constraints reject a global record with a
  workspace ID and a project record without one. Do not try to reopen the process-wide cached
  `DatabaseSync` singleton.
- [ ] **Step 2: Run RED:**
  `npx vitest run --root . apps/desktop/src/main/memory/project-memory-service.test.ts`.
  Expected: schema/table assertions fail before the migration exists.
- [ ] **Step 3: Add the migration.** Create records with a CHECK constraint for scopes/categories/statuses,
  project `workspace_id` with `ON DELETE CASCADE`, evidence `session_id` with `ON DELETE SET NULL`,
  transition history, scope enable settings, and indexes on `(workspace_id,status,last_verified_at)`
  and `(scope,status,last_verified_at)`. Avoid cascading the memory row from `agent_sessions`.
- [ ] **Step 4: Run GREEN** with the focused test command, then
  `npm --workspace @modus/desktop run typecheck`.

### Task 2: Implement scoped CRUD and lifecycle service

**Files:**
- Create: `apps/desktop/src/main/memory/project-memory-service.ts`
- Modify: `apps/desktop/src/main/memory/project-memory-service.test.ts`

**Interfaces:**
- Implement the exported service functions defined above using `getDatabase()`.
- `setProjectMemoryEnabled()` defaults to enabled if no setting row exists.
- `deleteProjectMemory()` deletes a record and its evidence/events transactionally; project workspace
  deletion cascades project records but leaves global records.

- [ ] **Step 1: Add failing tests** for project-A/project-B/global isolation, Inbox global-only retrieval,
  settings default-on/disable, dedupe-key idempotency, legal state transitions, explicit supersession,
  chat evidence detachment without transcript retention, project cascade, and rollback invalidation to
  `needs_review`.
- [ ] **Step 2: Run the focused service test** and verify RED is caused by missing CRUD/state behavior.
- [ ] **Step 3: Implement pure validation helpers and transactional service functions.** Normalize
  workspace-relative evidence paths against the owning session cwd/worktree, reject absolute/outside
  paths and oversized claims, persist no raw transcript/source snippets, and store state transitions
  with an actor/reason. A deleted chat only detaches session/run evidence; it does not delete a useful
  project/global claim. Global candidates from a project session must be category `preference` or
  `convention` and cite a user-origin message.
- [ ] **Step 4: Run GREEN** for the focused service tests and desktop typecheck.

**Phase 1 Oracle Gate:** After Tasks 1–2, @oracle reviews only the migration, scope isolation,
deletion/rollback behavior, and temporal-state invariants. Do not continue until material findings
are addressed and focused service tests pass. Gate rationale: scope/data-loss bugs are difficult to
reverse once durable memory exists.

---

## Phase 2 — Agent proposals, run lifecycle, and subagent sharing

### Task 3: Add the structured Project Memory tool and automatic promotion

**Files:**
- Create: `apps/desktop/src/main/agent/tools/project-memory-tools.ts`
- Create: `apps/desktop/src/main/agent/tools/project-memory-tools.test.ts`
- Modify: `apps/desktop/src/main/agent/pi-sdk-runtime.ts`
- Modify: `apps/desktop/src/shared/tools.ts` only if a dedicated UI catalog entry is needed.

**Interfaces:**
- Register a TypeBox tool named `project_memory_propose` in the existing `toolRegistry` for `chat`
  only. Planning/review runs can inspect memories through context, but cannot persist speculative
  plans/reviews as durable project facts.
- Tool input is a `ProjectMemoryProposalInput`; session/workspace/run/CWD/parent/worktree identity
  comes only from `resolveAgentToolContext()` and `getActiveAgentRun()`.
- The tool returns a candidate ID and category, not a renderer/main-process object or transcript.

- [ ] **Step 1: Write failing tool tests** for invalid categories, a missing owning session/run,
  workspace ID spoofing (tool has no such parameter), global preference scope, project-specific fact
  rejection from Inbox/global, path normalization, duplicate candidate idempotency, and subagent
  worktree candidates starting `provisional`.
- [ ] **Step 2: Run RED** with `npx vitest run --root . apps/desktop/src/main/agent/tools/project-memory-tools.test.ts`.
- [ ] **Step 3: Implement the tool.** Use existing `AgentToolContext` and active run data; validate the
  current user message link for global scope; require non-trivial claims and evidence references.
  Register the tool in `PiSdkRuntime`'s constructor beside `registerTodoTools()` and
  `registerSubagentTools()`; prompt guidance says to use it only for durable decisions, constraints,
  reusable fixes, meaningful failed attempts, and task outcomes—not ordinary narration.
- [ ] **Step 4: Run GREEN** with the focused tool tests and desktop typecheck.

### Task 4: Connect promotion, compaction, close, rollback, and child harvest

**Files:**
- Modify: `apps/desktop/src/main/agent/pi-sdk-runtime.ts`
- Modify: `apps/desktop/src/main/agent/rollback-service.ts`
- Modify: `apps/desktop/src/main/agent/session-lifecycle.ts`
- Modify: `apps/desktop/src/main/agent/tools/wait-tools.ts` / shared wait-result types if needed.
- Tests: adjacent PiSdk runtime, rollback, tool, and wait tests.

**Interfaces:**
- `run.completed` invokes `finalizeProjectMemoryRun({ sessionId, runId, outcome: "completed" })`.
- Failed/cancelled outcomes can only activate a categorized `failed_attempt` if it has evidence;
  normal solution/decision candidates remain ineligible.
- Successful automatic `compaction.ended` and explicit manual `compact()` both attach/consolidate
  candidates for that run; aborted/will-retry compaction does not independently promote records.
  Event and manual paths share an idempotency key so one compaction is processed once.
- Explicit archive/close performs a best-effort idempotent finalization sweep; idle/unmount/runtime
  disposal is not a completion signal.
- Rollback invalidates memories linked to truncated run IDs in the same SQLite transaction that
  truncates agent history.
- `wait()` includes a short cited summary of child memory candidates; child worktree records remain
  provisional until parent verification or integration.

- [ ] **Step 1: Write failing lifecycle tests** for completed run promotion, failed/cancelled run
  failed-attempt semantics, automatic and manual successful compaction, aborted/will-retry compaction,
  repeated finalizer idempotency, archive after run completion, rollback invalidation before run
  deletion, and child wait summaries that expose IDs/categories/claims but no raw transcript.
- [ ] **Step 2: Run the focused lifecycle tests** and confirm the pre-hook state fails as expected.
- [ ] **Step 3: Add finalizer calls at existing authoritative boundaries only.** Treat DB writes as
  best-effort after the agent's primary run outcome is recorded; memory-service errors must not flip a
  successful agent run to failed. Hook both normalized automatic compaction events and
  `PiSdkRuntime.compact()`; do not double-count one compaction. In `truncateSessionHistory`, invalidate
  linked memories in its transaction before deleting events/runs. Do not alter child task status
  semantics.
- [ ] **Step 4: Run GREEN** for focused lifecycle tests, rollback tests, wait tests, and typecheck.

**Phase 2 Oracle Gate:** @oracle reviews ownership/provenance, automatic promotion rules, transaction
ordering on rollback, and provisional subagent handling. Gate rationale: incorrect provenance can
make unverified changes appear to be durable project truth.

---

## Phase 3 — Context Planner and shadow retrieval

### Task 5: Implement deterministic scoped ranking and candidate-source seam

**Files:**
- Create: `apps/desktop/src/main/context/context-planner.ts`
- Create: `apps/desktop/src/main/context/context-planner.test.ts`
- Modify: `apps/desktop/src/main/memory/project-memory-service.ts` only for a narrow indexed query API.

**Interfaces:**

```ts
export type ContextCandidate = {
  id: string;
  sourceId: string;
  scope: ProjectMemoryScope;
  text: string;
  score: number;
  trust: "local-memory" | "code-map" | "external-reference";
  evidence: ProjectMemoryEvidence[];
  verifiedAt?: string;
};

export interface ContextCandidateSource {
  readonly sourceId: string;
  retrieve(input: ContextPlannerInput): Promise<ContextCandidate[]>;
}

export type ContextPlannerInput = ProjectMemoryRetrievalInput & {
  sessionId: string;
  runId?: string;
};

export function planTurnContext(
  input: ContextPlannerInput,
  sources?: ContextCandidateSource[],
): Promise<ProjectMemoryDigest>;
```

- [ ] **Step 1: Write failing ranking tests** for exact file/symbol matches outranking generic recent
  memories, task-term overlap, verified-recent facts beating old unverified facts, global/project
  filtering, exclusion of provisional/needs-review/obsolete/superseded records, deduplication, and a
  strict 1,200-token packer cap.
- [ ] **Step 2: Verify RED** with the Context Planner focused test file.
- [ ] **Step 3: Implement local scoring/packing** using normalized term overlap, exact relative path
  and symbol matches, branch/HEAD/changed-path evidence, category usefulness, verification state,
  and last verification age. Do not depend on FTS5; index scope/status/timestamps in SQLite and score
  a bounded local result set. Keep the production `ProjectMemoryDigest` shape stable; expose ranking
  IDs/reasons through a narrow shadow-diagnostic helper for the fixed test corpus, never prompt text.
- [ ] **Step 4: Preserve the optional CodeGraph source seam without introducing a turn-time dependency.**
  Current Fast Codebase tool results are prose and no cached typed-location resolver is exposed. Do not
  parse that prose or invoke `runFastCodebase()` from the planner/new-turn path. Use validated path/
  symbol evidence already persisted with local memories; leave the CodeGraph source unregistered until
  agent-initiated discovery can supply typed, validated hits. If a future cached, non-sync resolver is
  added, call it with a short deadline and fail soft. No Context7/GitHub implementation is added.
- [ ] **Step 5: Run GREEN** and record fixed-corpus relevance, empty-index fallback, and token-budget
  evidence in the Deepwork progress file.

**Phase 3 Oracle Gate:** @oracle reviews scope filtering, ranking validity, CodeGraph isolation,
token budget, and prompt-injection boundaries in the candidate format. Gate rationale: retrieval
quality and trust errors can contaminate every subsequent turn.

---

## Phase 4 — Turn injection, IPC, and Settings manager

### Task 6: Inject one cited low-trust digest per new user turn

**Files:**
- Modify: `apps/desktop/src/main/agent/pi-sdk-runtime.ts`
- Modify: `apps/desktop/src/main/context/context-planner.ts`
- Test: adjacent runtime or Context Planner integration tests.

**Interfaces:**
- `composeTurnMessage(runtimeSession, input)` calls `planTurnContext()` for a new user message and
  formats a `<project_memory_context>` block before `input.message`.
- The memory block includes only `active` eligible claims, status, category, memory ID, and short
  evidence references; it is explicitly described as untrusted, possibly stale data that must be
  checked against the current source.
- Do not inject for automatic threshold-compaction continuation; do not duplicate one digest when
  the same already-running turn receives a steer/follow-up. A distinct user follow-up can get a fresh
  digest using the current context.

- [ ] **Step 1: Write a failing integration test** that starts a prompt with one active memory and
  verifies the composed user message includes the cited low-trust block; add assertions that
  obsolete/provisional entries and memory text as a system/developer prompt are absent.
- [ ] **Step 2: Add tests** for threshold compaction continuation and queued steer/follow-up to verify
  no duplicate digest is injected.
- [ ] **Step 3: Wire the planner** into `composeTurnMessage()` without changing `@ Past Chats`, skill
  prompts, tool prompts, or current user message ordering. Planner/DB failures log a safe warning and
  return an empty digest so the turn proceeds.
- [ ] **Step 4: Run GREEN** for focused PiSdk runtime and context-planner tests plus typecheck.

### Task 7: Add scoped IPC and the Settings memory manager

**Files:**
- Modify: `apps/desktop/src/shared/contracts.ts`
- Add/modify: `apps/desktop/src/main/ipc/channels.ts`, `schemas.ts`, `register-app-ipc.ts`.
- Create: `apps/desktop/src/main/ipc/project-memory-ipc.ts` and `.test.ts`.
- Modify: `apps/desktop/src/preload/types.ts`, `index.ts`.
- Modify: `apps/desktop/src/renderer/src/app/App.tsx` to pass the active workspace ID to Settings.
- Modify: `apps/desktop/src/renderer/src/features/settings/SettingsPanel.tsx`.
- Create: `apps/desktop/src/renderer/src/features/settings/projectMemory.test.ts`.

**Interfaces:**
- Expose `window.modus.projectMemory.snapshot({ workspaceId? })`, `setEnabled({ scope, enabled })`,
  `verify({ memoryId })`, `markObsolete({ memoryId })`, and `delete({ memoryId })`.
- IPC validates IDs/scopes with Zod, calls the current trusted-sender guard, and main rechecks that
  a requested workspace exists and record actions belong to global or the selected workspace.
- Settings shows global records and current-project records only; Inbox (`CHATS_WORKSPACE_ID`) only
  shows global memory. Provisional records have a clear state and a “Verify” action; the UI can pause
  either scope, obsolete, or delete records.

- [ ] **Step 1: Write failing IPC tests** for global/project list isolation, cross-project ID
  rejection, disabled settings persistence, verify/obsolete/delete schema validation, untrusted
  sender rejection, and DTOs with no raw transcript/source contents.
- [ ] **Step 2: Run RED** for focused memory IPC tests.
- [ ] **Step 3: Add the typed IPC/preload surface** with strict schemas and validated service calls.
- [ ] **Step 4: Write failing renderer helper tests** for scope grouping, status/evidence labels,
  verify action visibility only for provisional/needs-review, pause state, and removal confirmations.
- [ ] **Step 5: Ask @designer to implement the manager UI** in existing Settings styling, with clear
  scope toggle, records list, category/status/source/last-verified metadata, and verify/obsolete/delete
  controls. Preserve other Settings layout and avoid graph UI.
- [ ] **Step 6: Run GREEN** for focused IPC/UI tests and desktop typecheck.

**Phase 4 Oracle Gate:** @oracle reviews IPC authorization, data deletion, Settings scope isolation,
and final memory trust presentation. Gate rationale: the UI and API control access to persisted
project knowledge.

---

## Phase 5 — Cross-boundary verification

### Task 8: Verify the complete Project Intelligence flow

**Files:**
- No implementation changes except fixes for failing feature tests or actionable review findings.

- [ ] **Step 1: Run focused tests** for memory service, proposal tool, runtime lifecycle, planner,
  IPC, and Settings manager. Confirm candidate creation → successful promotion → retrieval → cited
  prompt injection works end-to-end with temporary SQLite state.
- [ ] **Step 2: Run negative/safety cases:** user text that looks like an instruction stays lower
  trust; no raw transcript is persisted; Inbox sees global only; Project A never sees Project B;
  project deletion cascades; chat deletion detaches evidence; rollback invalidates linked records;
  provisional worktree records are excluded until verification.
- [ ] **Step 3: Run `npx biome check` on new files**, `npm --workspace @modus/desktop run typecheck`,
  `npm --workspace @modus/desktop run build`, and `npm test`.
- [ ] **Step 4: Compare any full-suite/check failures to `origin/main`; report exact baseline and
  feature results rather than masking pre-existing failures. Confirm `git diff --check` and inspect
  the branch diff/status. Do not commit or open a PR unless the user asks.

## Self-review

- **Spec coverage:** SQLite/temporal data is Tasks 1–2; automatic current-run capture and successful
  promotion/failed-attempt semantics are Tasks 3–4; subagent and worktree sharing/rollback/deletion
  are Tasks 2–4; Context Planner, Git/file/symbol relevance and 1,200-token budget are Tasks 5–6;
  low-trust turn injection is Task 6; future source seams are Task 5; Settings control and IPC are
  Task 7; verification is Task 8.
- **Placeholder scan:** no TBD/TODO steps; all tasks have exact file ownership, defined interfaces,
  test behaviors, and commands.
- **Type consistency:** scope union, record fields, category/status enums, proposal context, snapshot,
  digest and Settings IPC signatures are defined before later tasks consume them.
- **Ownership/dependencies:** fixer owns database/service/tool/IPC/runtime files; designer owns the
  Settings manager UI and its tests; shared DTOs are established in Task 1. Oracle gates are separate
  read-only checkpoints after each deepwork phase. Do not run concurrent writers on the same files.
- **Commit policy:** no commit/PR is part of this plan unless the user explicitly requests it later.
