import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CHATS_WORKSPACE_ID } from "../../../shared/contracts";
import { getDatabase } from "../../db/database";
import { getProjectMemorySnapshot } from "../../memory/project-memory-service";
import { PROJECT_MEMORY_TOOL_NAME } from "./project-memory-tools";
import { toolRegistry } from "./registry";
import { type AgentToolContext, runWithAgentToolContext } from "./tool-context";

const testState = vi.hoisted(() => ({ userData: "" }));

vi.mock("electron", () => ({ app: { getPath: () => testState.userData } }));

let root: string;
let db: DatabaseSync;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "modus-project-memory-tools-"));
  testState.userData = root;
  db = getDatabase();
  const now = new Date().toISOString();
  db.prepare(`insert into workspaces (id, root_path, display_name, is_git_repository, last_opened_at, created_at)
    values (?, ?, ?, 0, ?, ?), (?, ?, ?, 0, ?, ?)`).run(
    "ws-tool",
    "/repo",
    "Tool project",
    now,
    now,
    CHATS_WORKSPACE_ID,
    "/inbox",
    "Inbox",
    now,
    now,
  );
  db.prepare(`insert into agent_sessions (id, workspace_id, title, cwd, status, created_at, updated_at)
    values (?, ?, ?, ?, 'idle', ?, ?), (?, ?, ?, ?, 'idle', ?, ?)`).run(
    "session-tool",
    "ws-tool",
    "Project chat",
    "/repo",
    now,
    now,
    "session-inbox-tool",
    CHATS_WORKSPACE_ID,
    "Inbox chat",
    "/inbox",
    now,
    now,
  );
  const { PiSdkRuntime } = await import("../pi-sdk-runtime");
  new PiSdkRuntime();
});

beforeEach(() => {
  db.exec("delete from project_memory_records; delete from agent_runs;");
});

afterAll(() => {
  db?.close();
  rmSync(root, { recursive: true, force: true });
});

function activeRun(
  sessionId = "session-tool",
  userMessageId = `message-${randomUUID()}`,
): { runId: string; userMessageId: string } {
  const runId = `run-${randomUUID()}`;
  db.prepare(`insert into agent_runs (id, session_id, user_message_id, prompt, status, started_at)
    values (?, ?, ?, ?, 'running', ?)`).run(
    runId,
    sessionId,
    userMessageId,
    "user request",
    new Date().toISOString(),
  );
  return { runId, userMessageId };
}

function tool() {
  const definition = toolRegistry
    .getCustomToolDefinitions("chat")
    .find((candidate) => candidate.name === PROJECT_MEMORY_TOOL_NAME);
  if (!definition?.execute) throw new Error(`${PROJECT_MEMORY_TOOL_NAME} is not registered`);
  return definition;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    scope: "project",
    category: "decision",
    title: "Use the local cache",
    claim: "The service uses a local cache for repeated reads.",
    evidence: [{ kind: "run" }],
    ...overrides,
  };
}

function context(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
  return {
    workspaceId: "ws-tool",
    cwd: "/repo",
    sessionId: "session-tool",
    ...overrides,
  };
}

async function execute(params: unknown, owner = context()) {
  const args = params as Parameters<NonNullable<ReturnType<typeof tool>["execute"]>>[1];
  return runWithAgentToolContext(owner, () =>
    tool().execute?.("project-memory-call", args, new AbortController().signal, undefined, {
      cwd: owner.cwd,
    } as Parameters<NonNullable<ReturnType<typeof tool>["execute"]>>[4]),
  );
}

describe("project_memory_propose", () => {
  it("registers in chat only and rejects invalid categories and renderer workspace fields", () => {
    expect(toolRegistry.resolveActiveTools("chat")).toContain(PROJECT_MEMORY_TOOL_NAME);
    expect(toolRegistry.resolveActiveTools("plan")).not.toContain(PROJECT_MEMORY_TOOL_NAME);
    expect(toolRegistry.resolveActiveTools("review")).not.toContain(PROJECT_MEMORY_TOOL_NAME);
    const definition = tool();
    expect(definition.description).toMatch(/durable decisions/i);
    expect(definition.description).toMatch(/not ordinary narration/i);
    const schema = definition.parameters;
    expect(Value.Check(schema, input())).toBe(true);
    expect(Value.Check(schema, input({ category: "narration" }))).toBe(false);
    expect(Value.Check(schema, input({ workspaceId: "spoofed-workspace" }))).toBe(false);
    expect(Value.Check(schema, input({ sessionId: "spoofed-session", runId: "spoofed-run" }))).toBe(
      false,
    );
  });

  it("requires an owning session and active run", async () => {
    await expect(execute(input(), context({ sessionId: "" }))).rejects.toThrow(/session/i);
    await expect(execute(input())).rejects.toThrow(/run/i);
  });

  it("derives workspace/session/run identity and stores only the current user-message provenance", async () => {
    const current = activeRun();
    const result = await execute(
      input({
        scope: "global",
        category: "preference",
        title: "Use tabs",
        claim: "The user prefers tabs for indentation.",
        evidence: [{ kind: "user_message" }],
      }),
    );
    expect(result?.details).toMatchObject({ category: "preference" });
    expect(Object.keys(result?.details ?? {}).sort()).toEqual(["candidateId", "category"]);
    expect(result?.details).not.toHaveProperty("claim");
    expect(result?.details).not.toHaveProperty("evidence");
    const message = result?.content[0];
    expect(message?.type).toBe("text");
    expect(message?.type === "text" ? message.text : "").not.toContain("The user prefers tabs");
    const memory = getProjectMemorySnapshot().memories.find(
      (candidate) => candidate.id === (result?.details as { candidateId: string }).candidateId,
    );
    expect(memory?.scope).toEqual({ kind: "global" });
    expect(memory?.evidence[0]).toMatchObject({
      kind: "user_message",
      sessionId: "session-tool",
      runId: current.runId,
      userMessageId: current.userMessageId,
    });
  });

  it("rejects global non-preferences and project-scoped Inbox facts", async () => {
    activeRun();
    await expect(execute(input({ scope: "global", category: "architecture" }))).rejects.toThrow(
      /global/i,
    );
    await expect(execute(input({ scope: "global", category: "decision" }))).rejects.toThrow(
      /global/i,
    );
    const inboxRun = activeRun("session-inbox-tool", "inbox-message");
    void inboxRun;
    await expect(
      execute(
        input(),
        context({
          workspaceId: CHATS_WORKSPACE_ID,
          sessionId: "session-inbox-tool",
          cwd: "/inbox",
        }),
      ),
    ).rejects.toThrow(/inbox/i);
  });

  it("normalizes evidence paths and deduplicates repeated proposals", async () => {
    const current = activeRun();
    const params = input({ evidence: [{ kind: "file", path: "src/cache.ts" }] });
    const first = await execute(params);
    const second = await execute(params);
    const firstId = (first?.details as { candidateId: string }).candidateId;
    expect((second?.details as { candidateId: string }).candidateId).toBe(firstId);
    const memory = getProjectMemorySnapshot("ws-tool").memories.find(
      (candidate) => candidate.id === firstId,
    );
    expect(memory?.evidence).toContainEqual(
      expect.objectContaining({
        path: "src/cache.ts",
        sessionId: "session-tool",
        runId: current.runId,
      }),
    );
  });

  it("creates worktree proposals as provisional from persisted session ownership", async () => {
    const now = new Date().toISOString();
    db.prepare(`insert into agent_sessions (id, workspace_id, title, cwd, status, parent_session_id,
      subagent_worktree_path, subagent_integration_status, created_at, updated_at)
      values (?, ?, ?, ?, 'idle', ?, ?, 'running', ?, ?)`).run(
      "session-worktree-tool",
      "ws-tool",
      "Child",
      "/repo/.worktrees/child",
      "session-tool",
      "/repo/.worktrees/child",
      now,
      now,
    );
    activeRun("session-worktree-tool", "worktree-message");
    const result = await execute(
      input(),
      context({ sessionId: "session-worktree-tool", cwd: "/repo/.worktrees/child" }),
    );
    const candidateId = (result?.details as { candidateId: string }).candidateId;
    expect(
      getProjectMemorySnapshot("ws-tool").memories.find((candidate) => candidate.id === candidateId)
        ?.status,
    ).toBe("provisional");
  });
});
