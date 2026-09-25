import { describe, expect, it, vi } from "vitest";
import type { TrustedSenderEvent } from "./trusted-sender";

describe("project memory IPC registration", () => {
  it("uses explicit sender selection, not snapshot requests, as project authority", async () => {
    const { registerProjectMemoryIpcHandlers } = await import("./project-memory-ipc");
    const { registerTrustedSender, assertTrustedSender } = await import("./trusted-sender");
    const handlers = new Map<string, (event: TrustedSenderEvent, input?: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn(
        (channel: string, handler: (event: TrustedSenderEvent, input?: unknown) => unknown) =>
          handlers.set(channel, handler),
      ),
    };
    const service = {
      getProjectMemorySnapshot: vi.fn((workspaceId?: string) => ({
        globalEnabled: true,
        projectEnabled: Boolean(workspaceId),
        memories: [],
      })),
      setProjectMemoryEnabled: vi.fn(),
      verifyProjectMemory: vi.fn(),
      markProjectMemoryObsolete: vi.fn(),
      deleteProjectMemory: vi.fn(),
    };
    registerProjectMemoryIpcHandlers(
      ipcMain,
      assertTrustedSender,
      service,
      (id) => ["project-a", "project-b"].includes(id),
      (id) => ({ kind: "project", workspaceId: id === "memory-a" ? "project-a" : "project-b" }),
    );
    const senderA = { mainFrame: { url: "file:///a.html" } };
    const senderB = { mainFrame: { url: "file:///b.html" } };
    const unregisterA = registerTrustedSender(senderA, "file:///a.html");
    const unregisterB = registerTrustedSender(senderB, "file:///b.html");
    const eventA = { sender: senderA, senderFrame: senderA.mainFrame };
    const eventB = { sender: senderB, senderFrame: senderB.mainFrame };
    const select = handlers.get("workspace:select");
    expect(select).toBeDefined();
    select?.(eventA, { workspaceId: "project-a" });
    expect(() =>
      handlers.get("project-memory:snapshot")?.(eventA, { workspaceId: "project-b" }),
    ).toThrow("Workspace is outside the current selection.");
    expect(() =>
      handlers.get("project-memory:verify")?.(eventA, { memoryId: "memory-a" }),
    ).not.toThrow();
    expect(() => handlers.get("project-memory:verify")?.(eventA, { memoryId: "memory-b" })).toThrow(
      "Project memory is outside the current workspace scope.",
    );
    expect(service.verifyProjectMemory).toHaveBeenCalledWith("memory-a");
    select?.(eventB, { workspaceId: "project-b" });
    expect(
      handlers.get("project-memory:snapshot")?.(eventB, { workspaceId: "project-b" }),
    ).toMatchObject({
      projectEnabled: true,
    });
    expect(() => handlers.get("project-memory:verify")?.(eventB, { memoryId: "memory-a" })).toThrow(
      "Project memory is outside the current workspace scope.",
    );
    expect(() =>
      handlers.get("project-memory:verify")?.(eventA, { memoryId: "memory-a" }),
    ).not.toThrow();
    select?.(eventA, {});
    expect(handlers.get("project-memory:snapshot")?.(eventA, {})).toMatchObject({
      projectEnabled: false,
    });
    expect(() => handlers.get("project-memory:verify")?.(eventA, { memoryId: "memory-a" })).toThrow(
      "Project memory is outside the current workspace scope.",
    );
    select?.(eventA, { workspaceId: "modus-inbox-chats" });
    expect(
      handlers.get("project-memory:snapshot")?.(eventA, { workspaceId: "modus-inbox-chats" }),
    ).toMatchObject({
      projectEnabled: false,
    });
    expect(() => handlers.get("project-memory:verify")?.(eventA, { memoryId: "memory-a" })).toThrow(
      "Project memory is outside the current workspace scope.",
    );
    expect(() => select?.(eventA, { workspaceId: "missing" })).toThrow("Workspace not found.");
    expect(service.verifyProjectMemory).toHaveBeenCalledTimes(2);
    unregisterA();
    unregisterB();
  });

  it("validates input, guards senders, and enforces workspace scope for actions", async () => {
    const { registerProjectMemoryIpcHandlers } = await import("./project-memory-ipc");
    const { assertTrustedSender, registerTrustedSender } = await import("./trusted-sender");
    const handlers = new Map<string, (event: TrustedSenderEvent, input?: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn(
        (channel: string, handler: (event: TrustedSenderEvent, input?: unknown) => unknown) =>
          handlers.set(channel, handler),
      ),
    };
    const service = {
      getProjectMemorySnapshot: vi.fn((workspaceId?: string) => ({
        globalEnabled: true,
        projectEnabled: Boolean(workspaceId),
        memories: [],
      })),
      setProjectMemoryEnabled: vi.fn(
        (input: { scope: { kind: string; workspaceId?: string }; enabled: boolean }) => input,
      ),
      verifyProjectMemory: vi.fn(() => "verified"),
      markProjectMemoryObsolete: vi.fn(() => "obsolete"),
      deleteProjectMemory: vi.fn(() => "deleted"),
      getMemoryScope: vi.fn((memoryId: string) =>
        memoryId === "project-memory"
          ? { kind: "project" as const, workspaceId: "workspace-1" }
          : memoryId === "other-project-memory"
            ? { kind: "project" as const, workspaceId: "workspace-2" }
            : memoryId === "removed-project-memory"
              ? { kind: "project" as const, workspaceId: "missing" }
              : memoryId === "global-memory"
                ? { kind: "global" as const }
                : undefined,
      ),
    };
    const workspaceExists = vi.fn(
      (id: string) => id === "workspace-1" || id === "workspace-2" || id === "modus-inbox-chats",
    );

    registerProjectMemoryIpcHandlers(
      ipcMain,
      assertTrustedSender,
      service,
      workspaceExists,
      service.getMemoryScope,
    );
    const sender = { mainFrame: { url: "file:///index.html" } };
    const unregister = registerTrustedSender(sender, "file:///index.html");
    const trusted = { sender, senderFrame: sender.mainFrame };
    const selectWorkspace = handlers.get("workspace:select");
    expect(selectWorkspace).toBeDefined();
    expect(handlers.get("project-memory:snapshot")?.(trusted, {})).toEqual({
      globalEnabled: true,
      projectEnabled: false,
      memories: [],
    });
    expect(() =>
      handlers.get("project-memory:snapshot")?.(trusted, { workspaceId: "missing" }),
    ).toThrow("Workspace not found.");
    expect(
      handlers.get("project-memory:snapshot")?.(trusted, { workspaceId: "modus-inbox-chats" }),
    ).toEqual({
      globalEnabled: true,
      projectEnabled: false,
      memories: [],
    });
    expect(() => handlers.get("project-memory:snapshot")?.(trusted, { workspaceId: "" })).toThrow(
      "Invalid IPC payload",
    );
    expect(() =>
      handlers.get("project-memory:snapshot")?.(trusted, {
        workspaceId: "workspace-1",
        extra: true,
      }),
    ).toThrow("Invalid IPC payload");
    expect(() =>
      handlers.get("project-memory:set-enabled")?.(trusted, {
        scope: { kind: "global", workspaceId: "workspace-1" },
        enabled: true,
      }),
    ).toThrow("Invalid IPC payload");
    expect(() =>
      handlers.get("project-memory:verify")?.(trusted, { memoryId: "project-memory", extra: true }),
    ).toThrow("Invalid IPC payload");
    expect(() =>
      handlers.get("project-memory:set-enabled")?.(trusted, {
        scope: { kind: "project", workspaceId: "missing" },
        enabled: true,
      }),
    ).toThrow("Workspace not found.");
    expect(() =>
      handlers.get("project-memory:set-enabled")?.(trusted, {
        scope: { kind: "project", workspaceId: "modus-inbox-chats" },
        enabled: true,
      }),
    ).toThrow("Project memory is unavailable for the Chats inbox.");
    selectWorkspace?.(trusted, { workspaceId: "workspace-1" });
    expect(
      handlers.get("project-memory:snapshot")?.(trusted, { workspaceId: "workspace-1" }),
    ).toEqual({
      globalEnabled: true,
      projectEnabled: true,
      memories: [],
    });
    expect(() =>
      handlers.get("project-memory:set-enabled")?.(trusted, {
        scope: { kind: "project", workspaceId: "workspace-2" },
        enabled: true,
      }),
    ).toThrow("Project memory is outside the current workspace scope.");
    expect(
      handlers.get("project-memory:set-enabled")?.(trusted, {
        scope: { kind: "global" },
        enabled: false,
      }),
    ).toEqual({ scope: { kind: "global" }, enabled: false });
    expect(() =>
      handlers.get("project-memory:verify")?.(trusted, { memoryId: "project-memory" }),
    ).not.toThrow();
    expect(() =>
      handlers.get("project-memory:verify")?.(trusted, { memoryId: "other-project-memory" }),
    ).toThrow("Project memory is outside the current workspace scope.");
    expect(() =>
      handlers.get("project-memory:mark-obsolete")?.(trusted, { memoryId: "project-memory" }),
    ).not.toThrow();
    expect(() =>
      handlers.get("project-memory:delete")?.(trusted, { memoryId: "global-memory" }),
    ).not.toThrow();
    expect(() => handlers.get("project-memory:verify")?.(trusted, { memoryId: "missing" })).toThrow(
      "Project memory not found.",
    );
    expect(() =>
      handlers.get("project-memory:delete")?.(trusted, { memoryId: "removed-project-memory" }),
    ).toThrow("Workspace not found.");
    expect(() => handlers.get("project-memory:mark-obsolete")?.(trusted, { memoryId: "" })).toThrow(
      "Invalid IPC payload",
    );
    expect(() =>
      handlers.get("project-memory:snapshot")?.(
        { senderFrame: { url: "https://attacker.invalid/" } },
        {},
      ),
    ).toThrow("Blocked IPC call from untrusted renderer frame.");
    expect(workspaceExists).toHaveBeenCalledWith("missing");
    expect(service.getProjectMemorySnapshot).toHaveBeenCalledWith("modus-inbox-chats");
    expect(service.setProjectMemoryEnabled).toHaveBeenCalledWith({
      scope: { kind: "global" },
      enabled: false,
    });
    expect(service.verifyProjectMemory).toHaveBeenCalledWith("project-memory");
    unregister();
  });
});
