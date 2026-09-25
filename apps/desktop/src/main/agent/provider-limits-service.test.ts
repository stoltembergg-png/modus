import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createProviderLimitsService, type ProviderCredential } from "./provider-limits-service";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

function fakeChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

const openRouterBody = {
  data: { usage: 12.5, limit: 40, limit_remaining: 27.5 },
};
const deepSeekBody = {
  balance_infos: [
    { currency: "USD", total_balance: "3.42", granted_balance: "5", topped_up_balance: "0" },
  ],
};

function makeService(options: Partial<Parameters<typeof createProviderLimitsService>[0]> = {}) {
  const fetcher = vi.fn(options.fetch ?? (async () => new Response("{}")));
  const service = createProviderLimitsService({
    providers: () => [
      {
        id: "openrouter",
        name: "OpenRouter",
        connected: true,
        credential: "or-secret",
        source: "builtin",
        authKind: "api-key",
      },
      {
        id: "deepseek",
        name: "DeepSeek",
        connected: true,
        credential: "ds-secret",
        source: "builtin",
        authKind: "api-key",
      },
    ],
    ...options,
    fetch: fetcher,
  });
  return { service, fetcher };
}

function makeProvider(
  overrides: Partial<ProviderCredential> & Pick<ProviderCredential, "id">,
): ProviderCredential {
  return {
    ...overrides,
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    connected: overrides.connected ?? true,
  };
}

describe("provider limits service", () => {
  it.each([
    [
      "custom provider id collision",
      {
        id: "openrouter",
        name: "Custom",
        connected: true,
        credential: "custom-secret",
        source: "custom",
        authKind: "api-key",
      },
    ],
    [
      "built-in using OAuth",
      {
        id: "deepseek",
        name: "DeepSeek",
        connected: true,
        credential: "oauth-token",
        source: "builtin",
        authKind: "oauth",
      },
    ],
    [
      "built-in using relay",
      {
        id: "openrouter",
        name: "OpenRouter",
        connected: true,
        credential: "or-secret",
        source: "builtin",
        authKind: "api-key",
        baseUrl: "https://relay.example",
      },
    ],
  ] as const)("does not send credentials for %s", async (_case, provider) => {
    const { service, fetcher } = makeService({ providers: () => [makeProvider(provider)] });
    const state = await service.refreshProviderLimits();
    expect(fetcher).not.toHaveBeenCalled();
    expect(state.accounts[0]).toMatchObject({ status: "unavailable", metrics: [] });
  });

  it("rejects HTTP redirects for fixed provider endpoints", async () => {
    const { service, fetcher } = makeService({
      fetch: async () => new Response("redirect", { status: 302 }),
    });
    await service.refreshProviderLimits();
    expect(fetcher.mock.calls.every(([, init]) => init.redirect === "error")).toBe(true);
  });

  it("forces refresh on account identity changes and does not retain prior-account metrics as stale", async () => {
    let credential = "first-account-key";
    let fail = false;
    const provider = () => [
      makeProvider({
        id: "openrouter",
        name: "OpenRouter",
        connected: true,
        credential,
        source: "builtin",
        authKind: "api-key",
      }),
    ];
    const { service, fetcher } = makeService({
      providers: provider,
      fetch: async () =>
        fail
          ? new Response("unavailable", { status: 500 })
          : new Response(JSON.stringify(openRouterBody)),
    });
    await service.getProviderLimits();
    credential = "second-account-key";
    fail = true;
    const next = await service.getProviderLimits();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(next.accounts[0]).toMatchObject({ status: "error", metrics: [] });
  });

  it.each([
    ["disconnect", { connected: false }],
    ["provider source change", { source: "custom" }],
    ["base URL change", { baseUrl: "https://relay.example" }],
  ] as const)("does not reuse in-flight/cache identity after %s", async (_case, change) => {
    let current = makeProvider({
      id: "openrouter",
      name: "OpenRouter",
      connected: true,
      credential: "account-key",
      source: "builtin",
      authKind: "api-key",
    });
    const fetch = vi.fn(async () => new Response(JSON.stringify(openRouterBody)));
    const { service } = makeService({ providers: () => [current], fetch });
    await service.getProviderLimits();
    current = { ...current, ...change };
    const result = await service.getProviderLimits();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.accounts[0]).toMatchObject({ status: "unavailable", metrics: [] });
  });

  it("does not deduplicate an in-flight request across credential identities", async () => {
    let credential = "first-key";
    let finishFirst!: () => void;
    const firstResponse = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let call = 0;
    const fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        await firstResponse;
        return new Response(JSON.stringify(openRouterBody));
      }
      return new Response(JSON.stringify({ data: { usage: 99, limit: 100 } }));
    });
    const providers = () => [
      makeProvider({
        id: "openrouter",
        name: "OpenRouter",
        connected: true,
        credential,
        source: "builtin",
        authKind: "api-key",
      }),
    ];
    const { service } = makeService({ providers, fetch });
    const oldRead = service.refreshProviderLimits();
    await Promise.resolve();
    credential = "second-key";
    const newRead = service.refreshProviderLimits();
    const requestsDuringIdentityChange = fetch.mock.calls.length;
    finishFirst();
    await Promise.all([newRead, oldRead]);
    expect(requestsDuringIdentityChange).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await service.getProviderLimits()).accounts[0]?.metrics[0]?.value).toBe(99);
  });

  it("does not return old-account metrics while the replacement identity is still loading", async () => {
    let credential = "old-key";
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    const oldResponse = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const newResponse = new Promise<void>((resolve) => {
      releaseNew = resolve;
    });
    let calls = 0;
    const fetch = vi.fn(async () => {
      const call = ++calls;
      if (call === 1) await oldResponse;
      else await newResponse;
      return new Response(
        JSON.stringify(call === 1 ? openRouterBody : { data: { usage: 99, limit: 100 } }),
      );
    });
    const providers = () => [
      makeProvider({
        id: "openrouter",
        name: "OpenRouter",
        connected: true,
        credential,
        source: "builtin",
        authKind: "api-key",
      }),
    ];
    const { service } = makeService({ providers, fetch });
    const oldRead = service.refreshProviderLimits();
    await Promise.resolve();
    credential = "new-key";
    const newRead = service.refreshProviderLimits();
    releaseOld();
    const superseded = await oldRead;
    expect(superseded.accounts[0]?.metrics[0]?.value).not.toBe(12.5);
    releaseNew();
    await newRead;
  });

  it("does not publish or cache Account A metrics if its identity changes during the request", async () => {
    let credential = "account-a-key";
    let releaseA!: () => void;
    const responseA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        await responseA;
        return new Response(JSON.stringify(openRouterBody));
      }
      return new Response(JSON.stringify({ data: { usage: 99, limit: 100 } }));
    });
    const providers = () => [
      makeProvider({
        id: "openrouter",
        name: "OpenRouter",
        connected: true,
        credential,
        source: "builtin",
        authKind: "api-key",
      }),
    ];
    const { service } = makeService({ providers, fetch });
    const accountARead = service.refreshProviderLimits();
    await Promise.resolve();
    credential = "account-b-key";
    releaseA();
    const result = await accountARead;
    expect(result.accounts[0]?.metrics[0]?.value).not.toBe(12.5);
    const current = await service.getProviderLimits();
    expect(current.accounts[0]?.metrics[0]?.value).toBe(99);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("uses only the fixed Codex command and read-only app-server methods, then kills the child", async () => {
    const child = fakeChildProcess();
    const sent: string[] = [];
    child.stdin.on("data", (chunk) => sent.push(chunk.toString("utf8")));
    spawnMock.mockReturnValueOnce(child);
    const service = createProviderLimitsService({
      providers: () => [],
      readCodexEnabled: () => true,
    });

    const pending = service.getProviderLimits();
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      ["app-server"],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      }),
    );
    child.stdout.write('{"jsonrpc":"2.0","id":0,"result":{}}\n');
    const sentAfterInitialize = sent.flatMap((line) =>
      line
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((value) => JSON.parse(value)),
    );
    expect(sentAfterInitialize.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "account/rateLimits/read",
    ]);
    child.stdout.write(
      '{"jsonrpc":"2.0","id":1,"result":{"rateLimits":{"primary":{"usedPercent":25}}}}\n',
    );

    expect(
      (await pending).accounts.find((account) => account.providerId === "chatgpt-codex"),
    ).toMatchObject({ status: "fresh" });
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit("close", 0, null);
  });

  it("kills and cleans up the Codex child when the bounded read times out", async () => {
    vi.useFakeTimers();
    const child = fakeChildProcess();
    spawnMock.mockReturnValueOnce(child);
    const service = createProviderLimitsService({
      providers: () => [],
      readCodexEnabled: () => true,
    });
    try {
      const pending = service.getProviderLimits();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(
        (await pending).accounts.find((account) => account.providerId === "chatgpt-codex"),
      ).toMatchObject({
        status: "error",
        message: "request-failed",
      });
      expect(child.kill).toHaveBeenCalledTimes(1);
      child.stdin.emit("error", new Error("late EPIPE"));
      child.emit("close", null, "SIGTERM");
      expect(child.listenerCount("error")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
      expect(child.stdin.listenerCount("error")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps stdin EPIPE handled after a successful result until the child closes", async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValueOnce(child);
    const service = createProviderLimitsService({
      providers: () => [],
      readCodexEnabled: () => true,
    });
    const pending = service.getProviderLimits();
    await Promise.resolve();
    await Promise.resolve();
    child.stdout.write('{"jsonrpc":"2.0","id":0,"result":{}}\n');
    child.stdout.write(
      '{"jsonrpc":"2.0","id":1,"result":{"rateLimits":{"primary":{"usedPercent":25}}}}\n',
    );
    const result = await pending;
    expect(result.accounts.find((account) => account.providerId === "chatgpt-codex")).toMatchObject(
      { status: "fresh" },
    );
    expect(child.stdin.listenerCount("error")).toBeGreaterThan(0);
    expect(() => child.stdin.emit("error", new Error("late EPIPE"))).not.toThrow();
    expect(result.accounts.find((account) => account.providerId === "chatgpt-codex")).toMatchObject(
      { status: "fresh" },
    );
    child.emit("close", 0, null);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.stdin.listenerCount("error")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
  });

  it("terminates the Codex child and returns a safe unavailable state on process failure", async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValueOnce(child);
    const service = createProviderLimitsService({
      providers: () => [],
      readCodexEnabled: () => true,
    });
    const pending = service.getProviderLimits();
    await Promise.resolve();
    await Promise.resolve();
    child.emit("error", new Error("private process detail"));
    expect(
      (await pending).accounts.find((account) => account.providerId === "chatgpt-codex"),
    ).toMatchObject({
      status: "unavailable",
      message: "codex-cli-missing",
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit("close", -1, null);
  });

  it("handles stdin EPIPE without an unhandled error and removes process listeners", async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValueOnce(child);
    const service = createProviderLimitsService({
      providers: () => [],
      readCodexEnabled: () => true,
    });
    const pending = service.getProviderLimits();
    await Promise.resolve();
    await Promise.resolve();
    expect(() => child.stdin.emit("error", new Error("EPIPE"))).not.toThrow();
    expect(
      (await pending).accounts.find((account) => account.providerId === "chatgpt-codex"),
    ).toMatchObject({
      status: "error",
      message: "request-failed",
    });
    child.emit("close", null, "EPIPE");
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stdin.listenerCount("error")).toBe(0);
  });

  it("settles and removes listeners when the Codex process exits before replying", async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValueOnce(child);
    const service = createProviderLimitsService({
      providers: () => [],
      readCodexEnabled: () => true,
    });
    const pending = service.getProviderLimits();
    await Promise.resolve();
    await Promise.resolve();
    child.emit("close", 1, null);
    expect(
      (await pending).accounts.find((account) => account.providerId === "chatgpt-codex"),
    ).toMatchObject({
      status: "error",
      message: "request-failed",
    });
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stdin.listenerCount("error")).toBe(0);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("caps total Codex stdout across JSONL chunks at 64 KiB", async () => {
    const child = fakeChildProcess();
    spawnMock.mockReturnValueOnce(child);
    const service = createProviderLimitsService({
      providers: () => [],
      readCodexEnabled: () => true,
    });
    const pending = service.getProviderLimits();
    await Promise.resolve();
    await Promise.resolve();
    const message = `${JSON.stringify({ method: "server/event", params: { data: "x".repeat(35_000) } })}\n`;
    child.stdout.write(message);
    child.stdout.write(message);
    expect(
      (await pending).accounts.find((account) => account.providerId === "chatgpt-codex"),
    ).toMatchObject({
      status: "error",
      message: "invalid-response",
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit("close", null, "SIGTERM");
  });

  it("does not return enabled Codex data after an in-flight refresh is superseded by opt-out", async () => {
    let releaseCodex!: (value: unknown) => void;
    const codexResponse = new Promise<unknown>((resolve) => {
      releaseCodex = resolve;
    });
    let fetchCall = 0;
    let releaseDisableRefresh!: () => void;
    const disableRefresh = new Promise<void>((resolve) => {
      releaseDisableRefresh = resolve;
    });
    const fetch = vi.fn(async () => {
      fetchCall += 1;
      if (fetchCall === 2) await disableRefresh;
      return new Response(JSON.stringify(openRouterBody));
    });
    let enabled = true;
    const service = createProviderLimitsService({
      providers: () => [
        makeProvider({
          id: "openrouter",
          name: "OpenRouter",
          connected: true,
          credential: "account-key",
          source: "builtin",
          authKind: "api-key",
        }),
      ],
      fetch,
      readCodexEnabled: () => enabled,
      writeCodexEnabled: (value) => {
        enabled = value;
      },
      readCodexRateLimits: () => codexResponse,
    });
    const oldRead = service.refreshProviderLimits();
    await Promise.resolve();
    await Promise.resolve();
    const disable = service.setCodexLimitsEnabled(false);
    await Promise.resolve();
    await Promise.resolve();
    releaseCodex({ rateLimits: { primary: { usedPercent: 80 } } });
    const superseded = await oldRead;
    expect(superseded.codexCliEnabled).toBe(false);
    expect(
      superseded.accounts.some(
        (account) => account.providerId === "chatgpt-codex" && account.metrics.length > 0,
      ),
    ).toBe(false);
    releaseDisableRefresh();
    await disable;
  });

  it("normalizes OpenRouter usage and key budget without leaking response fields", async () => {
    const { service, fetcher } = makeService({
      fetch: async (url) =>
        new Response(JSON.stringify(url.includes("openrouter") ? openRouterBody : deepSeekBody)),
    });
    const state = await service.refreshProviderLimits();
    const openrouter = state.accounts.find((account) => account.providerId === "openrouter");
    expect(openrouter).toMatchObject({ source: "openrouter-key", status: "fresh" });
    expect(openrouter?.metrics).toEqual([
      { id: "usage", label: "Key usage", kind: "usage", value: 12.5, unit: "USD" },
      {
        id: "budget",
        label: "Key budget",
        kind: "budget",
        value: 40,
        unit: "USD",
        limit: 40,
        remaining: 27.5,
      },
    ]);
    expect(JSON.stringify(state)).not.toContain("or-secret");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "https://openrouter.ai/api/v1/key",
      "https://api.deepseek.com/user/balance",
    ]);
  });

  it("normalizes DeepSeek balance with the provider currency", async () => {
    const { service } = makeService({
      fetch: async (url) =>
        new Response(JSON.stringify(url.includes("deepseek") ? deepSeekBody : openRouterBody)),
    });
    const state = await service.refreshProviderLimits();
    expect(state.accounts.find((account) => account.providerId === "deepseek")?.metrics).toEqual([
      { id: "balance", label: "Account balance", kind: "balance", value: 3.42, unit: "USD" },
    ]);
  });

  it("returns safe invalid-response and authentication-failed states", async () => {
    const { service } = makeService({
      fetch: async (url) =>
        url.includes("openrouter")
          ? new Response("private body", { status: 401 })
          : new Response(JSON.stringify({ balance_infos: [] })),
    });
    const state = await service.refreshProviderLimits();
    expect(state.accounts.find((account) => account.providerId === "openrouter")).toMatchObject({
      status: "error",
      message: "authentication-failed",
      metrics: [],
    });
    expect(state.accounts.find((account) => account.providerId === "deepseek")).toMatchObject({
      status: "error",
      message: "invalid-response",
      metrics: [],
    });
    expect(JSON.stringify(state)).not.toContain("private body");
  });

  it("does not request account data when supported providers have no stored credentials", async () => {
    const { service, fetcher } = makeService({
      providers: () => [
        { id: "openrouter", name: "OpenRouter", connected: true },
        { id: "deepseek", name: "DeepSeek", connected: true },
      ],
    });
    const state = await service.refreshProviderLimits();
    expect(fetcher).not.toHaveBeenCalled();
    expect(state.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "openrouter",
          status: "unavailable",
          message: "not-configured",
        }),
        expect.objectContaining({
          providerId: "deepseek",
          status: "unavailable",
          message: "not-configured",
        }),
      ]),
    );
  });

  it("defaults Codex opt-in off, persists the toggle, and avoids CLI access when disabled", async () => {
    const persist = vi.fn();
    const codex = vi.fn();
    const { service } = makeService({
      providers: () => [],
      readCodexEnabled: () => false,
      writeCodexEnabled: persist,
      readCodexRateLimits: codex,
    });
    expect((await service.getProviderLimits()).codexCliEnabled).toBe(false);
    expect(codex).not.toHaveBeenCalled();
    await service.setCodexLimitsEnabled(true);
    expect(persist).toHaveBeenCalledWith(true);
    await service.setCodexLimitsEnabled(false);
    expect(persist).toHaveBeenLastCalledWith(false);
  });

  it("normalizes Codex rate-limit windows from the opt-in read-only transport", async () => {
    const { service } = makeService({
      providers: () => [],
      readCodexEnabled: () => true,
      readCodexRateLimits: async () => ({
        rateLimits: {
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        },
      }),
    });
    const state = await service.getProviderLimits();
    expect(state.accounts.find((account) => account.providerId === "chatgpt-codex")).toMatchObject({
      source: "codex-cli",
      status: "fresh",
      metrics: [
        {
          id: "primary",
          kind: "rate-limit",
          value: 42,
          unit: "%",
          window: "300 minutes",
          resetAt: new Date(1_800_000_000_000).toISOString(),
        },
      ],
    });
  });

  it("reports a safe request error rather than a missing CLI when the read times out", async () => {
    const { service } = makeService({
      providers: () => [],
      readCodexEnabled: () => true,
      readCodexRateLimits: async () => {
        throw new Error("request-failed");
      },
    });
    expect(
      (await service.getProviderLimits()).accounts.find(
        (account) => account.providerId === "chatgpt-codex",
      ),
    ).toMatchObject({
      status: "error",
      message: "request-failed",
      metrics: [],
    });
  });

  it("reuses snapshots for 60 seconds and refreshes after expiry", async () => {
    let now = 10_000;
    const fetch = vi.fn(
      async (url: string) =>
        new Response(JSON.stringify(url.includes("openrouter") ? openRouterBody : deepSeekBody)),
    );
    const { service } = makeService({
      now: () => now,
      fetch,
    });
    await service.getProviderLimits();
    await service.getProviderLimits();
    expect(fetch).toHaveBeenCalledTimes(2);
    now += 60_001;
    await service.getProviderLimits();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("deduplicates concurrent reads for the same provider source", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fetch = vi.fn(async (url: string) => {
      await pending;
      return new Response(
        JSON.stringify(url.includes("openrouter") ? openRouterBody : deepSeekBody),
      );
    });
    const { service } = makeService({ fetch });
    const first = service.refreshProviderLimits();
    const second = service.refreshProviderLimits();
    expect(fetch).toHaveBeenCalledTimes(2);
    finish();
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("isolates provider failures and marks a previous successful snapshot stale", async () => {
    let fail = false;
    const { service } = makeService({
      fetch: async (url) => {
        if (url.includes("openrouter") && fail) return new Response("secret", { status: 500 });
        return new Response(
          JSON.stringify(url.includes("openrouter") ? openRouterBody : deepSeekBody),
        );
      },
    });
    await service.refreshProviderLimits();
    fail = true;
    const next = await service.refreshProviderLimits();
    expect(next.accounts.find((item) => item.providerId === "openrouter")).toMatchObject({
      status: "stale",
    });
    expect(next.accounts.find((item) => item.providerId === "deepseek")).toMatchObject({
      status: "fresh",
    });
  });

  it("keeps a successful snapshot stale when a later authentication response fails", async () => {
    let unauthorized = false;
    const { service } = makeService({
      fetch: async (url) => {
        if (url.includes("openrouter") && unauthorized)
          return new Response("secret", { status: 401 });
        return new Response(
          JSON.stringify(url.includes("openrouter") ? openRouterBody : deepSeekBody),
        );
      },
    });
    await service.refreshProviderLimits();
    unauthorized = true;
    const state = await service.refreshProviderLimits();
    expect(state.accounts.find((account) => account.providerId === "openrouter")).toMatchObject({
      status: "stale",
      message: "authentication-failed",
      metrics: expect.arrayContaining([expect.objectContaining({ value: 12.5 })]),
    });
  });
});
