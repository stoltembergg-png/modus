import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../../../shared/contracts";
import {
  formatRunDuration,
  hasPositiveTokenUsage,
  hasTurnFooterContent,
  type RunResponseModel,
  type RunTokenUsage,
  readRunResponseModel,
  readRunTokenUsage,
  resolveRunModelLabel,
  tokenUsageTotal,
} from "./runMetadata";

const usage: RunTokenUsage = {
  input: 8200,
  output: 4200,
  cacheRead: 1000,
  cacheWrite: 200,
  totalTokens: 13600,
};

const model = (id: string, name: string): ModelInfo =>
  ({
    id,
    name,
    provider: "anthropic",
    supportsThinking: false,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
  }) as ModelInfo;

describe("readRunTokenUsage", () => {
  it("accepts a fully numeric usage block", () => {
    expect(readRunTokenUsage(usage)).toEqual(usage);
  });

  it("rejects missing, partial or non-numeric blocks", () => {
    expect(readRunTokenUsage(undefined)).toBeUndefined();
    expect(readRunTokenUsage({ input: 1 })).toBeUndefined();
    expect(readRunTokenUsage({ ...usage, output: "x" })).toBeUndefined();
    expect(readRunTokenUsage({ ...usage, totalTokens: Number.NaN })).toBeUndefined();
  });
});

describe("hasPositiveTokenUsage", () => {
  it("shows only positive, provider-reported usage", () => {
    expect(hasPositiveTokenUsage(usage)).toBe(true);
    expect(hasPositiveTokenUsage(undefined)).toBe(false);
  });

  it("uses only the provider-reported total, never a component sum", () => {
    const zeroed: RunTokenUsage = { ...usage, totalTokens: 0 };
    expect(tokenUsageTotal(zeroed)).toBe(0);
    expect(hasPositiveTokenUsage(zeroed)).toBe(false);
  });
});

describe("hasTurnFooterContent", () => {
  it("keeps the footer when only metadata exists (no answer text)", () => {
    expect(hasTurnFooterContent(undefined, usage, undefined)).toBe(true);
    expect(hasTurnFooterContent(undefined, undefined, "Sonnet 4.5")).toBe(true);
  });

  it("keeps the footer for an answer-only turn", () => {
    expect(hasTurnFooterContent("the answer", undefined, undefined)).toBe(true);
  });

  it("renders nothing for a turn with no answer and no metadata", () => {
    expect(hasTurnFooterContent(undefined, undefined, undefined)).toBe(false);
  });
});

describe("readRunResponseModel", () => {
  it("accepts provider+model and keeps an optional responseModel", () => {
    expect(readRunResponseModel({ provider: "anthropic", model: "a", responseModel: "b" })).toEqual(
      {
        provider: "anthropic",
        model: "a",
        responseModel: "b",
      },
    );
    expect(readRunResponseModel({ provider: "anthropic", model: "a" })).toEqual({
      provider: "anthropic",
      model: "a",
    });
  });

  it("rejects blocks without provider/model", () => {
    expect(readRunResponseModel(undefined)).toBeUndefined();
    expect(readRunResponseModel({ model: "a" })).toBeUndefined();
  });
});

describe("resolveRunModelLabel", () => {
  const responseModel: RunResponseModel = {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    responseModel: "claude-sonnet-4-5-20250929",
  };

  it("prefers the provider's responseModel, resolved to the catalog name", () => {
    const models = [model("claude-sonnet-4-5-20250929", "Sonnet 4.5 (0929)")];
    expect(resolveRunModelLabel(models, responseModel)).toBe("Sonnet 4.5 (0929)");
  });

  it("shows the raw provider/responseModel when it is not in the catalog (never the requested model)", () => {
    // The requested model IS in the catalog — it must still not be used.
    const models = [model("claude-sonnet-4-5", "Sonnet 4.5")];
    expect(resolveRunModelLabel(models, responseModel)).toBe(
      "anthropic/claude-sonnet-4-5-20250929",
    );
  });

  it("uses the requested model only when no responseModel was reported", () => {
    const models = [model("claude-sonnet-4-5", "Sonnet 4.5")];
    expect(
      resolveRunModelLabel(models, { provider: "anthropic", model: "claude-sonnet-4-5" }),
    ).toBe("Sonnet 4.5");
  });

  it("shows the raw requested identifier when neither resolves", () => {
    expect(resolveRunModelLabel([], { provider: "anthropic", model: "claude-sonnet-4-5" })).toBe(
      "anthropic/claude-sonnet-4-5",
    );
  });

  it("uses the catalog name only — no thinking degree is appended", () => {
    const thinking = {
      id: "claude-sonnet-4-5",
      name: "Sonnet 4.5",
      provider: "anthropic",
      supportsThinking: true,
      thinkingLevel: "high",
      thinkingLevels: ["off", "high"],
    } as ModelInfo;
    expect(
      resolveRunModelLabel([thinking], { provider: "anthropic", model: "claude-sonnet-4-5" }),
    ).toBe("Sonnet 4.5");
  });

  it("omits the label without response metadata", () => {
    expect(resolveRunModelLabel([model("x", "X")], undefined)).toBeUndefined();
  });
});

describe("formatRunDuration", () => {
  it("measures from the prompt timestamp when known", () => {
    expect(formatRunDuration(1000, 3000, 23000)).toEqual({ label: "20s", fromPrompt: true });
  });

  it("flags the run-start fallback when no prompt timestamp exists", () => {
    expect(formatRunDuration(1000, undefined, 21000)).toEqual({ label: "20s", fromPrompt: false });
  });

  it("omits while the run has not settled", () => {
    expect(formatRunDuration(1000, undefined, undefined)).toBeUndefined();
  });
});
