# Provider Limits

## Summary

Add a **Limits** view inside Settings, reachable from a shortcut directly above the existing
Settings item in the app sidebar. Show configured model limits separately from live provider/account
usage so catalog metadata is never mistaken for an account quota.

## Goals

- Show context-window and maximum-output limits for enabled models from configured providers.
- Show account/key usage, balance, or rate-limit windows only when a supported source reports them.
- Support OpenRouter and DeepSeek through their official APIs and existing provider credentials.
- Optionally show ChatGPT/Codex rate-limit windows by querying the user's locally installed Codex CLI.
- Keep credentials and provider network access in Electron main; return only normalized display data to
  the renderer.

## Non-goals

- No scraping, browser cookies, private web endpoints, or copied KodexBar implementation.
- No generic calls to custom-provider URLs or arbitrary URLs supplied by the renderer.
- No admin/billing credential entry flow, cost forecasts, historical charts, alerts, or quota
  persistence.
- No automatic Codex CLI installation, prompt submission, or agent/code execution.
- Do not label model catalog limits, DeepSeek balance, or OpenRouter key budget as request/token
  rate limits when the source does not report those limits.

## User experience

1. Add a **Limits** shortcut immediately above the sidebar's Settings item. Selecting it opens the
   existing Settings panel directly on the Limits section; the normal Settings item keeps its
   current default section and behavior.
2. Add a Limits section to the Settings navigation and content panel.
3. Separate the content into:
   - **Model limits**: enabled models from connected/configured providers, showing provider, model,
     context window, and maximum output tokens when present. Label these as configured/model
     metadata. Missing values display as unavailable, not zero.
   - **Account usage**: one card per connected provider. Display only metrics the adapter can
     substantiate, along with source, last-updated time, and clear unavailable/error states.
4. Refresh supported sources when the section is opened if cached data is stale, and provide a
   manual refresh action. Do not poll continuously. Use a short in-memory cache (60 seconds) and
   retain the last successful snapshot as stale data if a refresh fails.
5. For ChatGPT/Codex, show an explicit opt-in control, off by default. Explain that it queries the
   local Codex CLI and that its app-server protocol is first-party but not a stable public API. If
   the CLI is absent or the feature is off, show a non-error unavailable/disabled state.

## Supported account sources

### OpenRouter

- Call the fixed official endpoint `GET https://openrouter.ai/api/v1/key` from the main process.
- Authenticate with the already-configured OpenRouter API key; do not expose it to the renderer.
- Normalize only usage and key-budget fields present in a valid response. Label these as **key
  usage/budget**, not a provider-wide request rate limit.

### DeepSeek

- Call the fixed official endpoint `GET https://api.deepseek.com/user/balance` from the main process.
- Authenticate with the already-configured DeepSeek API key; do not expose it to the renderer.
- Display the provider-reported account balance/credit with its currency/unit. This endpoint does not
  establish a request/token rate-limit window, so do not present the balance as one.

### ChatGPT / Codex (opt-in)

- Use the installed first-party `codex` CLI, not KodexBar and not direct access to CLI auth files.
- Query the CLI app-server's account rate-limit read method (`account/rateLimits/read`) using a
  fixed, read-only request. This protocol is internal/unstable; isolate it behind an adapter and
  handle protocol drift as an unavailable/error state.
- Require an explicit opt-in toggle that is off by default. Persist only that boolean in local app
  preferences; do not persist quota responses.
- Spawn a fixed executable/argument list without a shell, pass no workspace-controlled arguments,
  enforce a timeout, close the child after the read, and parse only the account/rate-limit response.
- Never read browser cookies, scrape web pages, log CLI protocol payloads, or expose CLI output to
  the renderer.

### Other connected providers

Show an honest “No supported account-usage source” state unless a provider is explicitly added to
the allowlist with an official documented endpoint and compatible credentials. Do not infer a
quota from successful model requests or catalog metadata.

## Architecture and trust boundaries

- Add a dedicated provider-limits service in the Electron main process. Keep the provider allowlist,
  fixed URLs, credential lookup, request validation, caching, and Codex CLI adapter there.
- Reuse existing main-process provider auth storage to obtain keys for the supported API adapters.
  Never accept credentials, URLs, provider base URLs, or arbitrary commands from the renderer.
- Add typed shared DTOs for normalized model limits, account metrics, source identity, timestamps,
  and status. Do not include raw responses, headers, tokens, API keys, or CLI protocol messages.
- Add a minimal typed preload/IPC surface for reading/refreshing Limits data and toggling Codex CLI
  opt-in. Validate IPC inputs with Zod and retain existing sender validation.
- Use fixed HTTPS origins and paths, bounded timeouts and response sizes, strict schema parsing,
  and cancellation where practical. Redact credentials and response bodies from errors/logs.
- Keep quota snapshots in memory only. Persist only the explicit Codex CLI opt-in preference.
- Treat provider-reported values and timestamps as untrusted display data; do not execute or render
  provider-supplied markup.

## Data and state semantics

- Model `contextWindow` and `maxTokens` are configured/catalog limits, not live usage or account
  entitlements.
- Account metrics are provider-specific and keep the provider's unit and semantics. Do not combine
  balances, key budgets, and time-window rate limits into one percentage.
- Each account card can be loading, fresh, stale after refresh failure, unavailable (unsupported or
  not configured), or error. A failed provider must not hide successful results from other providers.
- Authentication failures should suggest reconnecting/reconfiguring the provider without exposing
  response bodies or credential details. Rate limits/network failures should leave the last good
  value visible with its stale timestamp when available.
- Concurrent refreshes for the same source should be deduplicated; a later refresh must not allow an
  older response to overwrite newer data.

## Likely integration points

- Sidebar navigation: `apps/desktop/src/renderer/src/components/Sidebar.tsx`.
- Settings section routing and content: `apps/desktop/src/renderer/src/features/settings/SettingsPanel.tsx`.
- Initial Settings section/deep-link prop: `apps/desktop/src/renderer/src/app/App.tsx`.
- Provider auth/model metadata: `apps/desktop/src/main/agent/model-service.ts` and
  `apps/desktop/src/shared/contracts.ts`.
- Typed IPC boundary: `apps/desktop/src/main/ipc/channels.ts`, `schemas.ts`,
  `register-app-ipc.ts`, and `apps/desktop/src/preload/types.ts` / `index.ts`.

## Verification requirements

- Unit-test OpenRouter and DeepSeek response normalization, missing/invalid fields, authentication
  errors, timeout/network errors, and ensure secrets/raw response bodies never enter DTOs or logs.
- Unit-test Codex opt-in defaults off, fixed command invocation, timeout/cleanup, valid rate-limit
  parsing, and unsupported protocol responses without invoking a real account.
- Test IPC validation and that renderer-visible DTOs contain no credentials, headers, or raw
  provider/CLI payloads.
- Test Limits navigation/deep-linking, configured model limits, independent provider card failures,
  refresh/stale states, and accessibility of the opt-in control.
- Run focused tests plus desktop typecheck, lint, and the relevant build/test command before calling
  the feature complete.

## Approval checkpoint

This document is the design checkpoint. Do not implement the feature until the user approves this
specification. After approval, write a TDD-oriented implementation plan and then proceed with the
implementation and verification.
