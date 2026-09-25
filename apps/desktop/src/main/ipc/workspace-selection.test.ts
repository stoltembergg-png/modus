import { describe, expect, it } from "vitest";
import {
  clearSelectedWorkspace,
  getSelectedWorkspace,
  setSelectedWorkspace,
} from "./workspace-selection";

describe("main-owned workspace selection", () => {
  it("isolates senders and clears a removed workspace from every sender", () => {
    const senderA = {};
    const senderB = {};
    setSelectedWorkspace(senderA, "workspace-a");
    setSelectedWorkspace(senderB, "workspace-b");

    expect(getSelectedWorkspace(senderA)).toBe("workspace-a");
    expect(getSelectedWorkspace(senderB)).toBe("workspace-b");

    clearSelectedWorkspace("workspace-a");
    expect(getSelectedWorkspace(senderA)).toBeUndefined();
    expect(getSelectedWorkspace(senderB)).toBe("workspace-b");
  });
});
