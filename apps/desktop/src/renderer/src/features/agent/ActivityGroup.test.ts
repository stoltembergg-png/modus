import { describe, expect, it } from "vitest";
import type { GroupedWorkActivityItem, WorkFoldItem } from "./Timeline";
import { workFoldPhaseLabel } from "./ActivityGroup";

const thought = (id: string, text = "…", streaming = false): WorkFoldItem => ({
  id,
  type: "thought",
  text,
  ...(streaming ? { streaming: true } : {}),
});

const tool = (id: string, name: string, isComplete = false): WorkFoldItem => ({
  id,
  type: "tool",
  name,
  output: "",
  ...(isComplete ? { isComplete: true } : {}),
});

const compaction = (id: string, status: "running" | "done" = "running"): WorkFoldItem => ({
  id,
  type: "compaction",
  reason: "threshold",
  status,
});

const subagent = (id: string, status: "running" | "blocked" | "completed"): WorkFoldItem => ({
  id,
  type: "subagent",
  childSessionId: "child",
  task: "audit",
  subagentType: "reviewer",
  status,
});

const assistant = (id: string, streaming: boolean): WorkFoldItem => ({
  id,
  type: "message",
  role: "assistant",
  content: "…",
  ...(streaming ? { streaming: true } : {}),
});

const group = (id: string, items: WorkFoldItem[]): WorkFoldItem => ({
  id,
  type: "work-activity-group",
  items: items as GroupedWorkActivityItem[],
});

/**
 * The fold header shows a short, real phase label derived from the turn's
 * activity events (never a fabricated/timed label, never the trace's raw
 * detail). These tests pin the selection logic; the swap animation itself is a
 * DOM concern with no harness here.
 */
describe("workFoldPhaseLabel", () => {
  it("returns nothing until a real activity exists", () => {
    expect(workFoldPhaseLabel([])).toBeUndefined();
    expect(workFoldPhaseLabel([assistant("a", false)])).toBeUndefined();
  });

  it("maps each activity kind to its own concise phase", () => {
    expect(workFoldPhaseLabel([thought("t", "x", true)])).toBe("Thinking");
    expect(workFoldPhaseLabel([tool("r", "read")])).toBe("Reading");
    expect(workFoldPhaseLabel([compaction("c")])).toBe("Compacting context");
    expect(workFoldPhaseLabel([subagent("s", "running")])).toBe("Waiting on subagent");
    expect(workFoldPhaseLabel([assistant("a", true)])).toBe("Writing");
  });

  it("reports only running work — settled items produce no phase", () => {
    expect(workFoldPhaseLabel([tool("r", "read", true)])).toBeUndefined();
    expect(workFoldPhaseLabel([thought("t", "x", false)])).toBeUndefined();
    expect(workFoldPhaseLabel([compaction("c", "done")])).toBeUndefined();
    expect(workFoldPhaseLabel([subagent("s", "completed")])).toBeUndefined();
  });

  it("tracks the most recent phase as real events arrive (data-driven, no timer)", () => {
    const stages: WorkFoldItem[][] = [
      [thought("t", "plan", true)],
      [thought("t", "plan"), tool("r", "read")],
      [thought("t", "plan"), tool("r", "read", true), compaction("c")],
      [thought("t", "plan"), tool("r", "read", true), compaction("c"), assistant("a", true)],
    ];
    expect(stages.map(workFoldPhaseLabel)).toEqual([
      "Thinking",
      "Reading",
      "Compacting context",
      "Writing",
    ]);
  });

  it("uses the phase verb only — never the thought's raw detail shown in the trace", () => {
    const label = workFoldPhaseLabel([thought("t", "I will inspect the parser", true)]);
    expect(label).toBe("Thinking");
    expect(label).not.toContain("inspect");
  });

  it("reads past trailing non-phase items to the latest running activity", () => {
    expect(workFoldPhaseLabel([tool("r", "read"), assistant("a", false)])).toBe("Reading");
  });

  it("reads the tail of a work-activity-group", () => {
    expect(workFoldPhaseLabel([group("g", [tool("r", "read", true), thought("t", "x", true)])])).toBe(
      "Thinking",
    );
    expect(workFoldPhaseLabel([group("g", [tool("r", "read", true)])])).toBeUndefined();
  });
});
