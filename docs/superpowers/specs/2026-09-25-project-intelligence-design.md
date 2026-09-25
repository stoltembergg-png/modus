# Project Intelligence Design

## Status

Design proposal approved in conversation; this document is the written-spec review checkpoint.
Implementation and the implementation plan remain blocked until the user approves this document.

## Summary

Add a local-first Project Intelligence layer that stores concise, time-aware project and global
memories in the existing SQLite database, retrieves a bounded and cited digest before each new
agent turn, and lets the current agent propose useful memories without a second model call. Reuse
the existing Pi SDK turn composition, tool registry, Git data, and Fast Codebase/CodeGraph as
optional relationship enrichment. Do not rebuild the agent, history, or code-index systems.

## Goals

- Persist decisions, architecture facts, conventions, constraints, known issues, solutions, failed
  attempts, task outcomes, and cross-project preferences with provenance and temporal status.
- Automatically retrieve relevant memories before each new turn, ranking by task terms, recency of
  verification, current Git state, and paths/symbols implicated by the task.
- Limit the retrieved memory digest to 1,200 tokens and cite memory status and evidence.
- Automatically record non-trivial, evidence-backed memories proposed by the agent in its current
  execution; do not make an extra model call for consolidation.
- Share subagent discoveries with the parent as a short, cited result. Worktree-derived knowledge
  remains provisional until verified in the parent checkout or integrated.
- Provide a minimal Settings manager to inspect, pause, obsolete, and delete global/project
  memories.
- Keep extension seams for embeddings, a graph view, Context7, and GitHub code search, with no such
  dependency or external integration required in V1.

## Non-goals

- Replacing or rebuilding `@ Past Chats`, agent sessions, Fast Codebase, or CodeGraph.
- Persisting raw conversation transcripts or treating repository/chat text as privileged
  instructions.
- Embeddings, vector databases, a graph visualization, Context7 calls, or GitHub code search in V1.
- A separate background LLM call for memory extraction or consolidation.
- Treating every turn, event, or summary as durable memory; trivial or unsupported observations are
  not saved.
- Making CodeGraph sync/indexing a synchronous prerequisite for prompt submission.

## Confirmed current architecture

- The application database is `userData/modus.sqlite`, opened in
  `apps/desktop/src/main/db/database.ts`; it uses SQLite WAL, foreign keys, and additive,
  idempotent schema migration logic.
- `workspaces.id` is the durable project key. A project session's `workspace_id` is the scope key;
  `cwd`, branch, and commit are applicability evidence because linked worktrees can share the same
  workspace ID while using a different checkout.
- `getAgentRuntime()` in `apps/desktop/src/main/agent/runtime-registry.ts` currently returns
  `PiSdkRuntime`. `PiSdkRuntime.prompt()` and `composeTurnMessage()` in
  `apps/desktop/src/main/agent/pi-sdk-runtime.ts` are the active fresh-turn composition path.
- `apps/desktop/src/main/context/context-service.ts` provides explicit `@ Past Chats` and document
  context; neither is automatic project memory.
- Custom agent tools are registered in the existing tool registry and receive authenticated
  session/workspace/parent context through `AsyncLocalStorage` in
  `apps/desktop/src/main/agent/tools/tool-context.ts`.
- Child results are harvested through the existing wait/subagent tools. The legacy helpers in
  `apps/desktop/src/main/agent/pi-rpc-service.ts` are not selected by the active runtime registry.
- Fast Codebase/CodeGraph is a CLI integration that may initialize or sync an index and can be slow.
  It may enrich stored links or retrieval candidates when available but is not authoritative memory
  storage and never blocks the current turn.

## Product decisions

- **Scope:** `global` plus `project`. Project records are keyed by `workspace_id`. Inbox sessions
  with no real project use global memory only. Project turns may retrieve global and their own
  project records. Global memory is limited to universal preferences/conventions; code/project facts
  are not promoted globally.
- **Default:** global and project memory are enabled by default, with pause/disable controls in the
  manager.
- **Promotion:** automatic; the agent proposes structured candidates during the current run. Main
  validates scope, category, evidence references, size, deduplication, and lifecycle before
  promotion. No extra model call is made.
- **Deletion:** deleting a chat detaches source links but retains useful project memory without
  transcript text. Removing a project deletes project-scoped memories. Rollback moves memories from
  reverted runs to `needs_review` or invalidates them so they cannot contaminate later context.
- **Worktrees:** subagent discoveries are shared to the parent as cited `provisional` findings and
  are not retrieved as active guidance until parent verification or integration.
- **Consolidation:** after relevant run completion and compaction, with explicit close/archive as a
  complementary best-effort sweep. Idle, component unmount, and runtime disposal do not by
  themselves mean a session is complete.
- **Retrieval budget:** a hard cap of 1,200 estimated tokens per turn, with source/status/evidence
  citations and no network or CodeGraph indexing on the critical path.
- **User control:** a minimal Settings manager, not a graph view, lists memories by scope/category/
  status and allows pause, obsolete, and delete actions.

## Architecture

### 1. SQLite memory service

Create a dedicated main-process `ProjectMemoryService` beside the existing database and agent
services. SQLite remains the authoritative store. Use additive migrations and indexes that keep
lookups scoped and bounded.

The schema consists of:

1. **Memory records** — stable ID, `global`/`project` scope, nullable `workspace_id`, category,
   concise title/claim, lifecycle status, verification class, created/updated/last-verified times,
   deduplication key, and optional supersession target. The project scope enforces a non-null
   workspace; global scope enforces a null workspace.
2. **Evidence links** — memory ID plus source type and optional session/run/task reference, commit,
   branch, normalized workspace-relative file path, and symbol identifier/name. Do not store raw
   transcripts or copied file contents. Chat deletion detaches session/run references rather than
   cascading the memory; workspace removal cascades project records.
3. **Lifecycle events** — append-only transitions recording from/to status, reason, actor (user,
   main, parent verification), and timestamp. Supersession is explicit; creation time alone never
   makes an old decision obsolete.
4. **Scope settings** — global and per-project enabled flags, defaulting enabled. Removing a
   project removes its setting.

Categories are `decision`, `architecture`, `convention`, `constraint`, `known_issue`, `solution`,
`failed_attempt`, `task_result`, and `preference`. Lifecycle status is `candidate`, `active`,
`provisional`, `needs_review`, `superseded`, or `obsolete`. A failed attempt may be an active,
useful warning only when clearly labeled as an attempt that failed; it is never phrased as a
working solution. Only `active` and verified, applicable records enter normal retrieval.

### 2. Structured memory proposal tool and lifecycle

Add a narrow custom agent tool such as `project_memory_propose` through the existing tool registry.
Its input is limited to category, concise claim/title, global-vs-project scope, evidence references,
and optional supersession. Main derives the owning session, workspace, active run, and parent from
`AgentToolContext`; the model cannot provide arbitrary workspace IDs or file contents. Global scope
is accepted only for universal preferences/conventions with a referenced user-origin statement or
an Inbox/global source.

The tool writes an idempotent `candidate` with source/run evidence. On a relevant successful
`run.completed`, main validates the candidate and automatically promotes it to `active`; a failed
attempt can be retained only with evidence and the `failed_attempt` category. Invalid, duplicate,
trivial, oversized, secret-like, or unsupported candidates are rejected or deduplicated. A failure
or cancellation cannot promote a normal solution.

Successful compaction finalizes eligible candidates already produced in the run; it does not store
the summary wholesale. Session archive/close may perform a final resumable sweep. All promotion and
event handling is idempotent by candidate/run/source key. On rollback, affected records are moved to
`needs_review` before the source run is removed. Child proposals are shared with the parent at the
existing wait/harvest boundary as a short, cited summary. If the child worked in an unintegrated
worktree, its records remain `provisional` until the parent verifies them or integrates the work.

### 3. Context Planner and retrieval

Introduce a small `ContextPlanner` at `apps/desktop/src/main/context/context-planner.ts`. It
orchestrates typed context candidate sources and returns normalized candidates plus a bounded
`ProjectMemoryDigest`. V1 sources are:

- SQLite project/global memories (authoritative memory source).
- Current task prompt and explicitly supplied context paths/symbols.
- Cheap Git metadata such as current branch, HEAD, and changed paths when available.
- Optional Fast Codebase/CodeGraph location enrichment if a usable index is already available; do
  not initialize/synchronize an index or wait for a CLI query as part of prompt submission.

For each new user turn, before `composeTurnMessage()` sends the prompt:

1. Resolve scope: real workspace → global + that project; Inbox/no project → global only.
2. Fetch only enabled, active, applicable memories; exclude `provisional`, `needs_review`,
   `superseded`, and `obsolete` records.
3. Rank by lexical/task-term relevance, exact file/symbol overlap, Git branch/commit/changed-file
   overlap, category/usefulness, verification recency, and evidence quality. Creation recency alone
   is not authoritative.
4. Deduplicate, cap individual entries, and pack within 1,200 estimated tokens. Return citations
   including memory ID, category, status/verification, and evidence paths/commit where present.
5. If DB/Git/CodeGraph is unavailable, continue the turn without memory; never fail prompt
   submission or invent relevance.

Do not repeat the same digest on compaction continuation without a new user message. For steer or
follow-up input, use the active run context and avoid conflicting duplicate blocks. Keep the digest
separate from system/developer instructions and explicitly mark it as local, potentially stale
evidence that must be checked against current source.

The source contract returns candidates with stable source IDs, scope, content, score, evidence,
trust level, and verification time. Future embeddings, Context7 documentation, and GitHub code
search can implement that contract later; V1 makes no external requests and installs no embedding
dependency. Existing `@ Past Chats` remains a separate explicit context feature.

### 4. Project Memory manager

Add a small Settings section for global and current-project memory. It lists concise claims with
category, lifecycle/verification state, last-verified time, and linked source metadata. It offers
global/project pause controls and individual obsolete/delete actions. It never shows or stores chat
transcripts as memory source text. Show provisional worktree records separately and explain why they
are not yet in automatic context. A graph view and embedding-based browsing are not part of V1.

## Trust, privacy, and failure handling

- Memory content, user text, tool output, repo files, subagent reports, CodeGraph output, and future
  external results are untrusted evidence, never instructions. Do not insert them into the system
  or developer prompt.
- Do not persist raw chat transcripts or copied repository file contents. Store concise claims and
  structured provenance only; detach evidence on chat deletion.
- Main derives identity and scope from the owning session, validates enumerated categories/status,
  normalizes relative paths, bounds text/metadata size, rejects secret-like content, and performs
  writes transactionally.
- Global/project filtering must be enforced in service queries and IPC, not just renderer filters.
- SQLite failure, missing Git metadata, stale/missing CodeGraph indexes, or unavailable future
  candidate providers degrade to “no memory” and never block or fail an agent turn.
- Explicit settings disable prevents both retrieval and candidate writes for that scope. Project
  removal cascades all project memories; global memories remain.

## Implementation phases and approval gates

1. **Persistence and temporal semantics:** migration, scoped CRUD, settings, evidence links, lifecycle
   transitions, delete/rollback behavior. Gate: existing DB migration, scope isolation, state-machine,
   deletion, and rollback tests. Risk controlled: data loss and cross-project leakage.
2. **Structured candidate and lifecycle hooks:** memory proposal tool, run/compaction/archive
   promotion, deduplication, and subagent handoff. Gate: success/failure/cancel/idempotency and
   provisional-worktree tests. Risk controlled: trivial/unverified memories becoming authoritative.
3. **Shadow retrieval:** Context Planner, Git/path/symbol scoring, candidate citations, 1,200-token
   budget, no prompt injection. Gate: a fixed retrieval corpus, obsolete/provisional exclusion,
   fallback when Git/CodeGraph is absent, and measured local latency/selection quality.
4. **Turn injection and manager UI:** enable by default with project/global pause controls; inject a
   low-trust digest before each new turn and expose inspect/obsolete/delete actions. Gate: new,
   resumed, queued, compaction, and parent/child flows; adversarial memory text; one-digest-per-turn;
   user controls and regression suite.

Each phase gets focused verification and an independent Oracle review before the next. A material
security or migration finding is resolved and retested before continuing. Do not implement any phase
until the user approves this written spec and a TDD-oriented plan is prepared.

## Verification requirements

- **Database:** migrate an existing SQLite file without data loss; assert global/project uniqueness,
  project cascade, chat evidence detachment, and stable state-transition history.
- **Scope/privacy:** a record from Project A never appears in Project B; Inbox retrieves only global
  preferences; project-specific facts cannot be written globally; disabled scope has no reads/writes.
- **Retrieval:** deterministic ranking across lexical match, category, verification recency, Git
  branch/HEAD/changed paths, and file/symbol links; cap to 1,200 estimated tokens; omit
  provisional/stale/obsolete records; fall back when Git/CodeGraph is absent.
- **Prompt safety:** memory digest stays in a lower-trust user/context block; hostile remembered text
  cannot override system/developer instructions; no full transcript/raw file contents in DTOs.
- **Lifecycle:** completion, compaction, archive, cancellation, retry, duplicate events, restart,
  rollback, and child worktree integration are tested for idempotency and correct temporal status.
- **UI/API:** global/project manager scope, pause controls, obsolete/delete operations, source/status
  display, validated sender-checked IPC, and no renderer access to SQLite or raw process output.
- **Repository:** focused tests, desktop typecheck/build, relevant Biome/lint, full suite with baseline
  comparison, diff review, and no secrets staged.

## Approval checkpoint

This is the written design checkpoint. No implementation has started. The user must review and
approve this spec before the TDD implementation plan is written and code changes begin.
