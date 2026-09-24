import { describe, expect, it } from "vitest";
import { readSessionScroll, rememberSessionScroll } from "./sessionScrollMemory";

describe("sessionScrollMemory", () => {
  it("remembers and reads scroll offsets per session", () => {
    rememberSessionScroll("a", 420);
    rememberSessionScroll("b", 12);
    expect(readSessionScroll("a")).toBe(420);
    expect(readSessionScroll("b")).toBe(12);
    rememberSessionScroll("a", 800);
    expect(readSessionScroll("a")).toBe(800);
  });

  it("clamps negative offsets to zero", () => {
    rememberSessionScroll("neg", -40);
    expect(readSessionScroll("neg")).toBe(0);
  });
});
