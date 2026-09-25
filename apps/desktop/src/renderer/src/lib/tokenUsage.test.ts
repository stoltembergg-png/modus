import { describe, expect, it } from "vitest";
import { formatTokenCount } from "./tokenUsage";

describe("formatTokenCount", () => {
  it("shows exact counts below one thousand", () => {
    expect(formatTokenCount(1)).toBe("1");
    expect(formatTokenCount(842)).toBe("842");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("compacts thousands and millions, dropping a trailing .0", () => {
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(1200)).toBe("1.2k");
    expect(formatTokenCount(12400)).toBe("12.4k");
    expect(formatTokenCount(120000)).toBe("120k");
    expect(formatTokenCount(1200000)).toBe("1.2M");
  });

  it("renders a real zero, and nothing for invalid/negative input", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(-5)).toBe("");
    expect(formatTokenCount(Number.NaN)).toBe("");
    expect(formatTokenCount(Number.POSITIVE_INFINITY)).toBe("");
  });
});
