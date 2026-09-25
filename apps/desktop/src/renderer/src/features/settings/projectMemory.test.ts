import { describe, expect, it, vi } from "vitest";
import type {
  ProjectMemoryRecord,
  ProjectMemoryScope,
  ProjectMemorySnapshot,
  ProjectMemoryVerification,
} from "../../../../shared/contracts";
import {
  confirmProjectMemoryRemoval,
  groupProjectMemories,
  projectMemoryProvisionalExplanation,
  projectMemoryStatusLabel,
  projectMemoryVerificationLabel,
  projectMemoryVerifyVisible,
  setProjectMemoryScopeEnabled,
} from "./SettingsPanel";

const record = (
  id: string,
  scope: ProjectMemoryScope,
  overrides: Partial<ProjectMemoryRecord> = {},
): ProjectMemoryRecord => ({
  id,
  scope,
  category: "decision",
  title: id,
  claim: `${id} claim`,
  status: "active",
  verification: "tests_passed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  evidence: [{ kind: "run" }],
  ...overrides,
});

const snapshot = (memories: ProjectMemoryRecord[]): ProjectMemorySnapshot => ({
  globalEnabled: true,
  projectEnabled: true,
  memories,
});

describe("groupProjectMemories", () => {
  it("returns global and matching project records, excluding other projects", () => {
    const groups = groupProjectMemories(
      [
        record("global", { kind: "global" }),
        record("current", { kind: "project", workspaceId: "ws-a" }),
        record("other", { kind: "project", workspaceId: "ws-b" }),
      ],
      "ws-a",
    );
    expect(groups.global.map(({ id }) => id)).toEqual(["global"]);
    expect(groups.project.map(({ id }) => id)).toEqual(["current"]);
  });

  it("shows only global records in Inbox", () => {
    const groups = groupProjectMemories(
      [
        record("global", { kind: "global" }),
        record("inbox", { kind: "project", workspaceId: "modus-inbox-chats" }),
      ],
      "modus-inbox-chats",
    );
    expect(groups.global.map(({ id }) => id)).toEqual(["global"]);
    expect(groups.project).toEqual([]);
  });
});

describe("project memory trust labels", () => {
  it("uses clear status labels and only offers Verify for provisional or needs-review records", () => {
    expect(projectMemoryStatusLabel("provisional")).toBe("Provisional");
    expect(projectMemoryStatusLabel("needs_review")).toBe("Needs review");
    expect(projectMemoryVerifyVisible("provisional")).toBe(true);
    expect(projectMemoryVerifyVisible("needs_review")).toBe(true);
    expect(projectMemoryVerifyVisible("active")).toBe(false);
    expect(projectMemoryVerifyVisible("obsolete")).toBe(false);
  });

  it("explains provisional child/worktree findings are excluded from automatic context", () => {
    expect(projectMemoryProvisionalExplanation()).toContain("child/worktree");
    expect(projectMemoryProvisionalExplanation()).toContain(
      "excluded from automatic memory context",
    );
    expect(projectMemoryProvisionalExplanation()).toContain(
      "parent-checkout verification or integration",
    );
  });

  it.each([
    ["user_explicit", "User explicit"],
    ["agent_observed", "Agent observed"],
    ["tests_passed", "Tests passed"],
    ["parent_verified", "Parent verified"],
    ["unverified", "Unverified"],
  ] as const)("labels %s verification as %s", (verification, expected) => {
    expect(projectMemoryVerificationLabel(verification satisfies ProjectMemoryVerification)).toBe(
      expected,
    );
  });
});

describe("setProjectMemoryScopeEnabled", () => {
  it("updates the selected scope and persists the toggle", async () => {
    const initial = snapshot([]);
    const onSnapshot = vi.fn();
    const persist = vi.fn(async () => ({ ...initial, projectEnabled: false }));

    await setProjectMemoryScopeEnabled({
      snapshot: initial,
      scope: { kind: "project", workspaceId: "ws-a" },
      enabled: false,
      onSnapshot,
      persist,
    });

    expect(onSnapshot).toHaveBeenNthCalledWith(1, { ...initial, projectEnabled: false });
    expect(persist).toHaveBeenCalledWith({
      scope: { kind: "project", workspaceId: "ws-a" },
      enabled: false,
    });
    expect(onSnapshot).toHaveBeenLastCalledWith({ ...initial, projectEnabled: false });
  });

  it("restores the previous state if persistence fails", async () => {
    const initial = snapshot([]);
    const onSnapshot = vi.fn();
    await expect(
      setProjectMemoryScopeEnabled({
        snapshot: initial,
        scope: { kind: "global" },
        enabled: false,
        onSnapshot,
        persist: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
    expect(onSnapshot).toHaveBeenLastCalledWith(initial);
  });
});

describe("confirmProjectMemoryRemoval", () => {
  it("runs the chosen action only after confirmation", async () => {
    const confirm = vi.fn().mockReturnValue(false);
    const remove = vi.fn();
    await expect(confirmProjectMemoryRemoval("mem-1", "delete", confirm, remove)).resolves.toBe(
      false,
    );
    expect(remove).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await expect(confirmProjectMemoryRemoval("mem-1", "obsolete", confirm, remove)).resolves.toBe(
      true,
    );
    expect(remove).toHaveBeenCalledWith("mem-1", "obsolete");
  });
});
