# Provider Limits Implementation Plan

> **For agentic workers:** Implement this plan task-by-task with the TDD cycle. Do not commit changes unless the user explicitly requests a commit.

**Goal:** Add a Limits destination inside Settings showing configured model limits and truthful account usage from supported providers.

**Architecture:** The renderer gets normalized account snapshots through a narrow typed preload/IPC API. Electron main owns the fixed provider allowlist, auth lookup, network requests, short-lived cache, Codex CLI adapter, and opt-in preference. The Settings UI reads configured model caps from its existing `ModelSettingsState`; it keeps model configuration separate from account usage.

**Tech Stack:** Electron main/preload IPC, TypeScript shared contracts, Zod, React, Vitest, existing SQLite `app_settings` storage.

**Spec:** `docs/superpowers/specs/2026-09-25-provider-limits.md`

## Global Constraints

- Do not implement until the user approves the spec; approval received.
- Keep provider credentials and HTTP/CLI work in Electron main; renderer-visible results contain no secrets or raw payloads.
- Allowlist only OpenRouter, DeepSeek, and opt-in local Codex CLI in V1; use fixed endpoints/command arguments.
- Never use scraping, browser cookies, private web endpoints, arbitrary custom-provider URLs, or prompt/code execution.
- Model `contextWindow`/`maxTokens`, OpenRouter key budgets, and DeepSeek balance are not request/token rate limits; label their semantics accurately.
- Codex CLI preference defaults off and is the only persisted Limits-specific value; quota snapshots remain in memory for 60 seconds.
- Write a failing test and verify the expected failure before each production behavior; run tests after each green step.
- Do not commit changes unless explicitly requested.

## File Structure

- `apps/desktop/src/shared/contracts.ts`: account usage DTOs shared across main, preload, and renderer.
- `apps/desktop/src/main/agent/provider-limits-service.ts`: provider adapters, bounded refresh/cache, model/account aggregation, and persisted Codex opt-in.
- `apps/desktop/src/main/agent/provider-limits-service.test.ts`: adapter parsing, status, cache, preference, and failure tests.
- `apps/desktop/src/main/ipc/channels.ts`, `schemas.ts`, `register-app-ipc.ts`: typed, validated, sender-checked IPC handlers.
- `apps/desktop/src/preload/types.ts`, `index.ts`: minimal typed `window.modus.model` methods.
- `apps/desktop/src/main/ipc/provider-limits-ipc.test.ts` (or the existing focused IPC test file if registration tests are co-located): validates safe IPC behavior.
- `apps/desktop/src/renderer/src/components/Sidebar.tsx`: Limits shortcut above Settings.
- `apps/desktop/src/renderer/src/app/App.tsx`: preserve Settings behavior and pass the requested initial section.
- `apps/desktop/src/renderer/src/features/settings/SettingsPanel.tsx`: Limits section navigation, content, status cards, refresh, and Codex opt-in.
- UI tests beside Sidebar/SettingsPanel: verify deep-link and visible data/status behavior using the repository's existing test conventions.

## Interfaces

Add these shared DTOs to `contracts.ts`:

```ts
export type ProviderUsageMetric = {
  id: string;
  label: string;
  kind: "budget" | "usage" | "balance" | "rate-limit";
  value: number;
  unit: string;
  limit?: number;
  remaining?: number;
  window?: string;
  resetAt?: string;
};

export type ProviderUsageSource = "openrouter-key" | "deepseek-balance" | "codex-cli";
export type ProviderUsageStatus = "fresh" | "stale" | "unavailable" | "error";
export type ProviderUsageMessage =
  | "unsupported"
  | "not-configured"
  | "authentication-failed"
  | "request-failed"
  | "codex-disabled"
  | "codex-cli-missing"
  | "invalid-response";

export type ProviderAccountUsage = {
  providerId: string;
  providerName: string;
  source?: ProviderUsageSource;
  status: ProviderUsageStatus;
  updatedAt?: string;
  metrics: ProviderUsageMetric[];
  message?: ProviderUsageMessage;
};

export type ProviderLimitsState = {
  accounts: ProviderAccountUsage[];
  codexCliEnabled: boolean;
};
```

Expose these exact methods through `window.modus.model`:

```ts
limits(): Promise<ProviderLimitsState>;
refreshLimits(): Promise<ProviderLimitsState>;
setCodexLimitsEnabled(enabled: boolean): Promise<ProviderLimitsState>;
```

`limits()` returns the current state and refreshes only expired/missing sources; `refreshLimits()`
forces supported sources; `setCodexLimitsEnabled(false)` persists opt-out and stops future CLI reads,
while `true` persists explicit opt-in and refreshes Codex once. Expected provider failures are
represented in the per-provider card rather than rejecting the entire state.

---

### Task 1: Add the normalized usage contract and official HTTP adapters

**Files:**
- Modify: `apps/desktop/src/shared/contracts.ts`
- Create: `apps/desktop/src/main/agent/provider-limits-service.ts`
- Create: `apps/desktop/src/main/agent/provider-limits-service.test.ts`
- Read: `apps/desktop/src/main/agent/model-service.ts` for `getModelRegistry()`, `getModelSettings()`, and key lookup.

**Interfaces:**
- Produce the shared DTOs and method signatures defined above.
- Export `getProviderLimits(): Promise<ProviderLimitsState>`, `refreshProviderLimits(): Promise<ProviderLimitsState>`, and `setCodexLimitsEnabled(enabled: boolean): Promise<ProviderLimitsState>` from the service; keep low-level parsers/adapters private unless a focused test requires an exported pure parser.
- OpenRouter uses only `GET https://openrouter.ai/api/v1/key`; DeepSeek uses only `GET https://api.deepseek.com/user/balance`.

- [ ] **Step 1: Write failing parser/adapter tests** for (a) valid OpenRouter key usage/budget, (b) valid DeepSeek balances with currency, (c) malformed responses, (d) 401 responses, and (e) missing stored credentials. Inject `fetch`/credential access through a service factory or equivalent seam; never make live requests in unit tests.
- [ ] **Step 2: Verify RED** with `npx vitest run --root . apps/desktop/src/main/agent/provider-limits-service.test.ts`; confirm the failure is the missing adapter/parser behavior, not a test setup/import error.
- [ ] **Step 3: Implement minimal adapters.** Read credentials only in main through the existing model registry, use fixed HTTPS URLs and bearer auth, cap request duration and response body size, parse only documented numeric fields, normalize each provider's semantics, and return `authentication-failed`, `request-failed`, `not-configured`, or `invalid-response` without raw errors or payloads.
- [ ] **Step 4: Verify GREEN** with the same focused Vitest command; then run `npm --workspace @modus/desktop run typecheck`.

### Task 2: Add Codex opt-in, provider aggregation, and the short-lived cache

**Files:**
- Modify: `apps/desktop/src/main/agent/provider-limits-service.ts`
- Modify: `apps/desktop/src/main/agent/provider-limits-service.test.ts`
- Use existing: `apps/desktop/src/main/db/database.ts` `app_settings` table.

**Interfaces:**
- Implement the three exported service functions from Task 1.
- Persist only `provider-limits.codex-enabled` as a boolean value in `app_settings`; absent value means `false`.
- Return one independent account card per connected provider. Unsupported connected providers get `unavailable`/`unsupported`; disconnected supported providers do not trigger network calls.

- [ ] **Step 1: Write failing tests** for opt-in defaulting off, persisting true/false, avoiding Codex invocation while disabled, showing unsupported provider cards, fresh-cache reuse for 60 seconds, refresh after expiry, per-provider failure isolation, and preventing an older overlapping response from replacing the newest snapshot.
- [ ] **Step 2: Verify RED** with the focused provider-limits Vitest command and check that each failure points to an absent behavior.
- [ ] **Step 3: Implement aggregation/cache.** Build model/provider identity from existing `getModelSettings()` and the provider allowlist; use injected clock/transport dependencies for deterministic TTL/concurrency tests. Cache snapshots in memory only. Store only the Codex boolean using the existing `app_settings` table.
- [ ] **Step 4: Verify GREEN** with the focused test command and desktop typecheck.

### Task 3: Implement the read-only Codex CLI adapter

**Files:**
- Modify: `apps/desktop/src/main/agent/provider-limits-service.ts`
- Modify: `apps/desktop/src/main/agent/provider-limits-service.test.ts`

**Interfaces:**
- Codex results normalize into `ProviderAccountUsage` with `providerId: "chatgpt-codex"`, `source: "codex-cli"`, and `kind: "rate-limit"` metrics containing the reported window, percent/value, and reset time.
- The CLI is invoked only from main, only after persisted opt-in, with a fixed executable/argument list, `shell: false`, no workspace/user-controlled arguments, and a bounded timeout.

- [ ] **Step 1: Write failing tests** with a fake child-process/app-server transport for disabled state, missing CLI, successful rate-limit windows, malformed/protocol-drift response, timeout, child cleanup, and ensuring no prompt/code-execution method is sent.
- [ ] **Step 2: Verify RED** with the focused provider-limits test command.
- [ ] **Step 3: Implement the adapter** around the fixed Codex app-server read method `account/rateLimits/read`. Parse only that response; never inspect auth files, browser data, or log protocol payloads. Convert process/protocol failures to safe normalized states.
- [ ] **Step 4: Verify GREEN** with focused tests and desktop typecheck. Tests must use the fake transport and must not invoke a real Codex account.

### Task 4: Add validated IPC and the typed preload surface

**Files:**
- Modify: `apps/desktop/src/main/ipc/channels.ts`
- Modify: `apps/desktop/src/main/ipc/schemas.ts`
- Modify: `apps/desktop/src/main/ipc/register-app-ipc.ts`
- Modify: `apps/desktop/src/preload/types.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Test: existing focused IPC registration tests or `apps/desktop/src/main/ipc/provider-limits-ipc.test.ts`.

**Interfaces:**
- Add channels `model:limits`, `model:limits-refresh`, and `model:limits-set-codex-enabled`.
- The first two accept no renderer-supplied provider, URL, or credential input. The toggle accepts exactly `{ enabled: boolean }`.
- Each handler calls `assertTrustedSender(event)` and the provider-limits service; preload forwards only the exact typed methods above.

- [ ] **Step 1: Write failing IPC/preload tests** proving the toggle rejects non-booleans/extra untrusted data, handlers enforce trusted senders, and the returned DTO has no credentials, headers, response bodies, or CLI stdout.
- [ ] **Step 2: Verify RED** with the targeted IPC test file.
- [ ] **Step 3: Add channels, Zod schema, sender-checked handlers, and typed preload methods.** Keep renderer inputs limited to the boolean toggle; do not expose the low-level adapter or fetch.
- [ ] **Step 4: Verify GREEN** with targeted IPC tests and `npm --workspace @modus/desktop run typecheck`.

### Task 5: Implement the Limits navigation and settings experience

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/Sidebar.tsx`
- Modify: `apps/desktop/src/renderer/src/app/App.tsx`
- Modify: `apps/desktop/src/renderer/src/features/settings/SettingsPanel.tsx`
- Test: the existing Sidebar/SettingsPanel component tests or adjacent focused test files.

**Interfaces:**
- Add `onOpenLimits(): void` to `SidebarProps`; the Limits shortcut calls it and renders immediately above the existing Settings row.
- Pass an optional `initialSection?: "general" | "model-provider" | "appearance" | "personalization" | "skills" | "subagents" | "mcp" | "rules" | "limits"` to `SettingsPanel`; default remains `"model-provider"`.
- UI calls only `window.modus.model.limits()`, `refreshLimits()`, and `setCodexLimitsEnabled(enabled)`.

- [ ] **Step 1: Write failing renderer tests** for Limits shortcut placement/action, direct opening of the Limits section, normal Settings default remaining unchanged, enabled configured model rows, no-data labels for missing model values, independent provider statuses, manual refresh, and Codex opt-in off-by-default.
- [ ] **Step 2: Verify RED** with the focused renderer test files.
- [ ] **Step 3: Implement the UI.** Derive the model list from `state.models` where `configured && enabled`; display `providerName`, model name, `contextWindow`, and `maxTokens` as configured values. Render account cards from `ProviderLimitsState`, preserve stale values after a refresh error, keep metric units/source/timestamp explicit, and explain that DeepSeek balance/OpenRouter key budget are not rate limits. Opening the section calls `limits()`; the refresh button calls `refreshLimits()`; the opt-in switch calls `setCodexLimitsEnabled()`.
- [ ] **Step 4: Verify GREEN** with focused renderer tests and desktop typecheck. Ensure keyboard operation, accessible switch naming, and reduced-motion compatibility using existing UI conventions.

### Task 6: Cross-boundary verification and final review

**Files:**
- No new feature files unless a failing verification requires a targeted fix; keep tests adjacent to their owners.

- [ ] **Step 1: Run focused service, IPC, and UI Vitest files** and inspect output for skipped/failing tests.
- [ ] **Step 2: Run `npm --workspace @modus/desktop run typecheck`.**
- [ ] **Step 3: Run `npm run check` and `npm test` from the repository root.**
- [ ] **Step 4: Review the final diff for arbitrary URLs/commands, renderer-visible secrets, raw errors, persisted quota snapshots, mislabeled metric semantics, missing cleanup, and duplicate refresh races. Do not claim completion unless all required checks pass; report any unavailable environment-dependent checks explicitly.

## Self-review

- **Spec coverage:** UI navigation/deep-link/model values are Task 5; official APIs are Task 1; cache, errors, and provider isolation are Task 2; Codex opt-in/protocol/process safety are Tasks 2–3; IPC trust boundary is Task 4; state UX/accessibility is Task 5; verification is Task 6.
- **Placeholder scan:** no TBD/TODO implementation steps; each task gives files, interfaces, test behaviors, and runnable verification commands.
- **Type consistency:** service functions and DTOs are defined before IPC and renderer consumption; Sidebar callback/SettingsPanel initial section are specified exactly; account metrics use normalized numeric values and provider units.
- **Ownership/dependencies:** the main/service/contract/IPC lane owns only main, shared, and preload files. The designer owns Sidebar, App, SettingsPanel, and renderer tests. The UI lane depends on the exact contract/API above but does not edit its files.
