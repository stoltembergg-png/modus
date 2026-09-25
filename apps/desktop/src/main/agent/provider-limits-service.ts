import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type {
  ProviderAccountUsage,
  ProviderLimitsState,
  ProviderUsageMessage,
  ProviderUsageMetric,
  ProviderUsageSource,
} from "../../shared/contracts";
import { getDatabase } from "../db/database";
import { getModelRegistry, getModelSettings } from "./model-service";

const TTL_MS = 60_000;
const BODY_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const CODEX_TIMEOUT_MS = 5_000;
const CODEX_SETTING_KEY = "provider-limits.codex-enabled";
const ENDPOINTS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1/key",
  deepseek: "https://api.deepseek.com/user/balance",
};

export type ProviderCredential = {
  id: string;
  name: string;
  connected: boolean;
  credential?: string;
  source?: "builtin" | "custom";
  authKind?: "api-key" | "oauth";
  baseUrl?: string;
};
export type ProviderLimitsDependencies = {
  providers: () => ProviderCredential[];
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  readCodexEnabled?: () => boolean;
  writeCodexEnabled?: (enabled: boolean) => void;
  readCodexRateLimits?: () => Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function number(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const size = Number(response.headers.get("content-length"));
  if (Number.isFinite(size) && size > BODY_LIMIT) throw new Error("too-large");
  if (!response.body) throw new Error("invalid-response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > BODY_LIMIT) {
      await reader.cancel();
      throw new Error("too-large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as unknown;
}

function parseOpenRouter(body: unknown): ProviderUsageMetric[] | undefined {
  if (!isRecord(body) || !isRecord(body.data)) return undefined;
  const data = body.data;
  const usage = number(data.usage);
  const limit = number(data.limit);
  const remaining = number(data.limit_remaining);
  if (usage === undefined && limit === undefined && remaining === undefined) return undefined;
  const metrics: ProviderUsageMetric[] = [];
  if (usage !== undefined)
    metrics.push({ id: "usage", label: "Key usage", kind: "usage", value: usage, unit: "USD" });
  if (limit !== undefined)
    metrics.push({
      id: "budget",
      label: "Key budget",
      kind: "budget",
      value: limit,
      unit: "USD",
      limit,
      ...(remaining !== undefined ? { remaining } : {}),
    });
  return metrics;
}

function parseDeepSeek(body: unknown): ProviderUsageMetric[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.balance_infos)) return undefined;
  const entry = body.balance_infos.find(
    (item) =>
      isRecord(item) &&
      typeof item.currency === "string" &&
      number(item.total_balance) !== undefined,
  );
  if (!isRecord(entry)) return undefined;
  const value = number(entry.total_balance);
  const currency =
    typeof entry.currency === "string" && /^[A-Z]{3}$/.test(entry.currency)
      ? entry.currency
      : undefined;
  if (value === undefined || !currency) return undefined;
  return [{ id: "balance", label: "Account balance", kind: "balance", value, unit: currency }];
}

function parseCodexRateLimits(payload: unknown): ProviderUsageMetric[] | undefined {
  if (!isRecord(payload)) return undefined;
  const limits = isRecord(payload.rateLimits) ? payload.rateLimits : payload;
  const candidates = [
    ["primary", "Primary", limits.primary],
    ["secondary", "Secondary", limits.secondary],
  ] as const;
  const metrics: ProviderUsageMetric[] = [];
  for (const [id, label, raw] of candidates) {
    if (!isRecord(raw)) continue;
    const used = number(raw.usedPercent);
    if (used === undefined || used > 100) continue;
    const resetAt =
      typeof raw.resetsAt === "number" && Number.isFinite(raw.resetsAt)
        ? new Date(raw.resetsAt * 1000).toISOString()
        : typeof raw.resetsAt === "string" && Number.isFinite(Date.parse(raw.resetsAt))
          ? new Date(raw.resetsAt).toISOString()
          : undefined;
    metrics.push({
      id,
      label,
      kind: "rate-limit",
      value: used,
      unit: "%",
      ...(typeof raw.windowDurationMins === "number" && Number.isFinite(raw.windowDurationMins)
        ? { window: `${raw.windowDurationMins} minutes` }
        : {}),
      ...(resetAt ? { resetAt } : {}),
    });
  }
  return metrics.length ? metrics : undefined;
}

function readCodexAppServer(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    let stdoutBytes = 0;
    let initialized = false;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("error", onChildError);
      child.removeListener("close", onChildClose);
      child.stdout?.removeListener("data", onStdoutData);
      child.stdin?.removeListener("error", onStdinError);
    };
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.stdin?.end();
      } catch {
        /* closing stdin is best effort */
      }
      child.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const onChildError = () => finish(new Error("codex-cli-missing"));
    const onChildClose = () => {
      if (!settled) finish(new Error("request-failed"));
      cleanup();
    };
    const onStdinError = () => {
      if (!settled) finish(new Error("request-failed"));
    };
    const onStdoutData = (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > BODY_LIMIT) return finish(new Error("invalid-response"));
      stdout += chunk.toString("utf8");
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (!initialized && message.id === 0 && "result" in message) {
            initialized = true;
            writeStdin(
              `${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`,
            );
            writeStdin(
              `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "account/rateLimits/read", params: {} })}\n`,
            );
          } else if (message.id === 1 && "result" in message) finish(undefined, message.result);
          else if ((message.id === 0 || message.id === 1) && "error" in message)
            finish(new Error("invalid-response"));
        } catch {
          /* wait for complete JSONL message */
        }
      }
    };
    const writeStdin = (message: string) => {
      try {
        child.stdin?.write(message);
      } catch {
        finish(new Error("request-failed"));
      }
    };
    const timer = setTimeout(() => finish(new Error("request-failed")), CODEX_TIMEOUT_MS);
    child.on("error", onChildError);
    child.on("close", onChildClose);
    child.stdout?.on("data", onStdoutData);
    child.stdin?.on("error", onStdinError);
    writeStdin(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          clientInfo: { name: "modus", title: "Modus", version: "0.1.0" },
          capabilities: {},
        },
      })}\n`,
    );
  });
}

function persistedCodexEnabled(): boolean {
  const row = getDatabase()
    .prepare("select value from app_settings where key = ?")
    .get(CODEX_SETTING_KEY) as { value: string | null } | undefined;
  return row?.value === "true";
}

function persistCodexEnabled(enabled: boolean): void {
  getDatabase()
    .prepare(
      `insert into app_settings (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(CODEX_SETTING_KEY, String(enabled), new Date().toISOString());
}

function productionDependencies(): ProviderLimitsDependencies {
  return {
    providers: () => {
      const settings = getModelSettings();
      const registry = getModelRegistry();
      return settings.providers
        .filter((provider) => provider.configured)
        .map((provider) => {
          const auth = registry.authStorage.get(provider.id);
          return {
            id: provider.id,
            name: provider.name,
            connected: provider.configured,
            source: provider.source,
            ...(provider.authKind ? { authKind: provider.authKind } : {}),
            ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
            ...(auth?.type === "api_key" ? { credential: auth.key } : {}),
          };
        });
    },
    readCodexEnabled: persistedCodexEnabled,
    writeCodexEnabled: persistCodexEnabled,
    readCodexRateLimits: readCodexAppServer,
  };
}

export function createProviderLimitsService(dependencies: ProviderLimitsDependencies) {
  const fetcher = dependencies.fetch ?? ((url, init) => fetch(url, init));
  const now = dependencies.now ?? Date.now;
  const readEnabled = dependencies.readCodexEnabled ?? (() => false);
  const writeEnabled = dependencies.writeCodexEnabled ?? (() => undefined);
  const codexRead = dependencies.readCodexRateLimits ?? readCodexAppServer;
  let snapshot: ProviderLimitsState | undefined;
  let cachedAt = 0;
  let snapshotIdentity = "";
  let snapshotProviderIdentities = new Map<string, string>();
  let generation = 0;
  const inFlight = new Map<string, Promise<ProviderAccountUsage>>();

  const identityFor = (provider: ProviderCredential): string =>
    createHash("sha256")
      .update(
        JSON.stringify([
          provider.id,
          provider.connected,
          provider.source,
          provider.authKind,
          provider.baseUrl ?? "",
          provider.credential ?? "",
        ]),
      )
      .digest("hex");
  const identitySetFor = (providers: ProviderCredential[]): string =>
    createHash("sha256")
      .update(
        JSON.stringify(
          providers
            .map((provider) => [provider.id, identityFor(provider)])
            .sort(([a], [b]) => String(a).localeCompare(String(b))),
        ),
      )
      .digest("hex");

  async function requestProvider(
    provider: ProviderCredential,
    identity: string,
  ): Promise<ProviderAccountUsage> {
    const source = provider.id === "openrouter" ? "openrouter-key" : "deepseek-balance";
    const endpoint = ENDPOINTS[provider.id];
    const staleOrError = (message: ProviderUsageMessage): ProviderAccountUsage => {
      const previous = snapshot?.accounts.find((account) => account.providerId === provider.id);
      if (
        snapshotProviderIdentities.get(provider.id) === identity &&
        previous?.source === source &&
        previous.metrics.length
      )
        return { ...previous, status: "stale", message };
      return {
        providerId: provider.id,
        providerName: provider.name,
        source,
        status: "error",
        message,
        metrics: [],
      };
    };
    if (!provider.connected)
      return {
        providerId: provider.id,
        providerName: provider.name,
        status: "unavailable",
        message: "not-configured",
        metrics: [],
      };
    if (!endpoint)
      return {
        providerId: provider.id,
        providerName: provider.name,
        status: "unavailable",
        message: "unsupported",
        metrics: [],
      };
    if (!provider.credential)
      return {
        providerId: provider.id,
        providerName: provider.name,
        status: "unavailable",
        message: "not-configured",
        metrics: [],
      };
    if (
      provider.source !== "builtin" ||
      provider.authKind !== "api-key" ||
      provider.baseUrl?.trim()
    ) {
      return {
        providerId: provider.id,
        providerName: provider.name,
        status: "unavailable",
        message: "unsupported",
        metrics: [],
      };
    }
    try {
      const response = await fetcher(endpoint, {
        method: "GET",
        redirect: "error",
        headers: { Authorization: `Bearer ${provider.credential}`, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 401 || response.status === 403) {
        return staleOrError("authentication-failed");
      }
      if (!response.ok) throw new Error("request-failed");
      const body = await readBoundedJson(response);
      const metrics = provider.id === "openrouter" ? parseOpenRouter(body) : parseDeepSeek(body);
      if (!metrics) return staleOrError("invalid-response");
      return {
        providerId: provider.id,
        providerName: provider.name,
        source,
        status: "fresh",
        updatedAt: new Date(now()).toISOString(),
        metrics,
      };
    } catch (error) {
      return staleOrError(error instanceof SyntaxError ? "invalid-response" : "request-failed");
    }
  }

  function request(provider: ProviderCredential, identity: string): Promise<ProviderAccountUsage> {
    const key = `${provider.id}:${identity}`;
    const active = inFlight.get(key);
    if (active) return active;
    const current = requestProvider(provider, identity).finally(() => {
      if (inFlight.get(key) === current) inFlight.delete(key);
    });
    inFlight.set(key, current);
    return current;
  }

  async function refreshProviderLimits(force = true): Promise<ProviderLimitsState> {
    const providers = dependencies.providers();
    const identity = identitySetFor(providers);
    const enabledAtStart = readEnabled();
    if (
      !force &&
      snapshot &&
      now() - cachedAt < TTL_MS &&
      snapshotIdentity === identity &&
      snapshot.codexCliEnabled === enabledAtStart
    )
      return snapshot;
    const current = ++generation;
    const providerRequests = providers.map((provider) => ({
      provider,
      identity: identityFor(provider),
    }));
    const identities = new Map(
      providerRequests.map(({ provider, identity }) => [provider.id, identity]),
    );
    const accounts = await Promise.all(
      providerRequests.map(({ provider, identity }) => request(provider, identity)),
    );
    const enabled = enabledAtStart;
    if (enabled) {
      try {
        const result = await codexRead();
        const metrics = parseCodexRateLimits(result);
        accounts.push(
          metrics
            ? {
                providerId: "chatgpt-codex",
                providerName: "ChatGPT / Codex",
                source: "codex-cli",
                status: "fresh",
                updatedAt: new Date(now()).toISOString(),
                metrics,
              }
            : {
                providerId: "chatgpt-codex",
                providerName: "ChatGPT / Codex",
                source: "codex-cli",
                status: "error",
                message: "invalid-response",
                metrics: [],
              },
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : "";
        const message: ProviderUsageMessage =
          reason === "codex-cli-missing"
            ? "codex-cli-missing"
            : reason === "invalid-response"
              ? "invalid-response"
              : "request-failed";
        accounts.push({
          providerId: "chatgpt-codex",
          providerName: "ChatGPT / Codex",
          source: "codex-cli",
          status: message === "codex-cli-missing" ? "unavailable" : "error",
          message,
          metrics: [],
        });
      }
    } else {
      accounts.push({
        providerId: "chatgpt-codex",
        providerName: "ChatGPT / Codex",
        source: "codex-cli",
        status: "unavailable",
        message: "codex-disabled",
        metrics: [],
      });
    }
    const next = { accounts, codexCliEnabled: enabled };
    const currentProviders = dependencies.providers();
    const currentIdentity = identitySetFor(currentProviders);
    const currentEnabled = readEnabled();
    if (current !== generation || identity !== currentIdentity || enabled !== currentEnabled) {
      if (
        snapshot &&
        snapshotIdentity === currentIdentity &&
        snapshot.codexCliEnabled === currentEnabled
      )
        return snapshot;
      const supersededAccounts: ProviderAccountUsage[] = currentProviders.map((provider) => {
        const identityAtStart = identities.get(provider.id);
        if (identityAtStart && identityAtStart === identityFor(provider)) {
          const account = accounts.find((candidate) => candidate.providerId === provider.id);
          if (account) return account;
        }
        const source: ProviderUsageSource | undefined =
          provider.id === "openrouter"
            ? "openrouter-key"
            : provider.id === "deepseek"
              ? "deepseek-balance"
              : undefined;
        const message: ProviderUsageMessage =
          !provider.connected || !provider.credential
            ? "not-configured"
            : !ENDPOINTS[provider.id] ||
                provider.source !== "builtin" ||
                provider.authKind !== "api-key" ||
                provider.baseUrl?.trim()
              ? "unsupported"
              : "request-failed";
        return {
          providerId: provider.id,
          providerName: provider.name,
          ...(source ? { source } : {}),
          status:
            message === "unsupported" || message === "not-configured"
              ? ("unavailable" as const)
              : ("error" as const),
          message,
          metrics: [],
        };
      });
      if (!currentEnabled) {
        supersededAccounts.push({
          providerId: "chatgpt-codex",
          providerName: "ChatGPT / Codex",
          source: "codex-cli",
          status: "unavailable",
          message: "codex-disabled",
          metrics: [],
        });
      } else if (enabled) {
        const codex = accounts.find((account) => account.providerId === "chatgpt-codex");
        if (codex) supersededAccounts.push(codex);
      } else {
        supersededAccounts.push({
          providerId: "chatgpt-codex",
          providerName: "ChatGPT / Codex",
          source: "codex-cli",
          status: "error",
          message: "request-failed",
          metrics: [],
        });
      }
      return { accounts: supersededAccounts, codexCliEnabled: currentEnabled };
    }
    snapshot = next;
    cachedAt = now();
    snapshotIdentity = identity;
    snapshotProviderIdentities = identities;
    return next;
  }

  return {
    getProviderLimits: () => refreshProviderLimits(false),
    refreshProviderLimits: () => refreshProviderLimits(true),
    async setCodexLimitsEnabled(enabled: boolean) {
      writeEnabled(enabled);
      snapshot = undefined;
      snapshotIdentity = "";
      snapshotProviderIdentities.clear();
      return refreshProviderLimits(true);
    },
  };
}

const service = createProviderLimitsService(productionDependencies());
export const getProviderLimits = service.getProviderLimits;
export const refreshProviderLimits = service.refreshProviderLimits;
export const setCodexLimitsEnabled = service.setCodexLimitsEnabled;
