import { describe, expect, it, vi } from "vitest";
import type { TrustedSenderEvent } from "./trusted-sender";

describe("provider limits IPC registration", () => {
  it("rejects untrusted senders at each Limits handler before calling the service", async () => {
    const { registerProviderLimitsIpcHandlers } = await import("./provider-limits-ipc");
    const { assertTrustedSender } = await import("./trusted-sender");
    const handlers = new Map<string, (event: TrustedSenderEvent, input?: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn(
        (channel: string, handler: (event: TrustedSenderEvent, input?: unknown) => unknown) =>
          handlers.set(channel, handler),
      ),
    };
    const service = {
      getProviderLimits: vi.fn(),
      refreshProviderLimits: vi.fn(),
      setCodexLimitsEnabled: vi.fn(),
    };

    registerProviderLimitsIpcHandlers(ipcMain, assertTrustedSender, service);
    const event = { senderFrame: { url: "https://attacker.invalid/" } };
    for (const channel of [
      "model:limits",
      "model:limits-refresh",
      "model:limits-set-codex-enabled",
    ]) {
      expect(() =>
        handlers.get(channel)?.(event, channel.endsWith("enabled") ? { enabled: true } : undefined),
      ).toThrow("Blocked IPC call from untrusted renderer frame.");
    }
    expect(service.getProviderLimits).not.toHaveBeenCalled();
    expect(service.refreshProviderLimits).not.toHaveBeenCalled();
    expect(service.setCodexLimitsEnabled).not.toHaveBeenCalled();
  });
});
