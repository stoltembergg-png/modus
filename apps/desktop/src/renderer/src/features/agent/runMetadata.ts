import type {
  AgentResponseModel,
  AgentRunTokenUsage,
  ModelInfo,
} from "../../../../shared/contracts";
import { lookupModel } from "../../lib/modelIdentity";
import { formatElapsed } from "./ActivityGroup";

/**
 * Aliases onto the runtime contract (`AgentRunTokenUsage` / `AgentResponseModel`)
 * so the timeline binds to one source of truth while these readers keep the
 * parsing defensive for older history / terse providers.
 */
export type RunTokenUsage = AgentRunTokenUsage;
export type RunResponseModel = AgentResponseModel;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Only a fully numeric provider-reported block counts; anything else is absent. */
export function readRunTokenUsage(value: unknown): RunTokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  if (
    !isFiniteNumber(usage.input) ||
    !isFiniteNumber(usage.output) ||
    !isFiniteNumber(usage.cacheRead) ||
    !isFiniteNumber(usage.cacheWrite) ||
    !isFiniteNumber(usage.totalTokens)
  ) {
    return undefined;
  }
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
  };
}

export function readRunResponseModel(value: unknown): RunResponseModel | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const model = value as Record<string, unknown>;
  if (typeof model.provider !== "string" || typeof model.model !== "string") {
    return undefined;
  }
  return {
    provider: model.provider,
    model: model.model,
    ...(typeof model.responseModel === "string" && model.responseModel.length > 0
      ? { responseModel: model.responseModel }
      : {}),
  };
}

/** The provider-reported total — never a locally summed component estimate. */
export function tokenUsageTotal(usage: RunTokenUsage): number {
  return usage.totalTokens;
}

/** Usage is shown only when the reported total is positive. */
export function hasPositiveTokenUsage(usage: RunTokenUsage | undefined): usage is RunTokenUsage {
  return usage !== undefined && usage.totalTokens > 0;
}

/**
 * The footer renders while any real content exists. Copy is gated on the answer
 * separately, so a turn with provider metadata but no answer text (partial
 * failure/cancel) still shows the model / usage line.
 */
export function hasTurnFooterContent(
  answer: string | undefined,
  usage: RunTokenUsage | undefined,
  modelLabel: string | undefined,
): boolean {
  return Boolean(answer) || usage !== undefined || modelLabel !== undefined;
}

/**
 * Effective model label for a turn, bound to the provider's metadata — never the
 * pane's current model.
 *
 * The provider's `responseModel` is the effective identity when given; only when
 * it is absent may the requested `model` stand in. A catalog match renders the
 * catalog `name` (NOT `modelIdentityLabel`, which would append the current
 * thinking degree — a setting this run never recorded). With no catalog match we
 * show the raw `provider/id` rather than guessing.
 */
export function resolveRunModelLabel(
  models: readonly ModelInfo[] | undefined,
  responseModel: RunResponseModel | undefined,
): string | undefined {
  if (!responseModel) {
    return undefined;
  }
  const reported =
    typeof responseModel.responseModel === "string" && responseModel.responseModel.length > 0
      ? responseModel.responseModel
      : undefined;
  const requested = responseModel.model.length > 0 ? responseModel.model : undefined;
  const effectiveId = reported ?? requested;
  if (!effectiveId) {
    return undefined;
  }
  const catalog = lookupModel(models, effectiveId);
  if (catalog) {
    return catalog.name;
  }
  return responseModel.provider ? `${responseModel.provider}/${effectiveId}` : effectiveId;
}

/** Turn duration plus whether it was measured from the prompt's send time. */
export type RunDuration = { label: string; fromPrompt: boolean };

/**
 * Turn duration from the linked user message's send time, or — when history has
 * no prompt timestamp — from `run.startedAt`. The `fromPrompt` flag lets the UI
 * label the fallback as run duration instead of implying time since the prompt.
 * Undefined while the run has not settled.
 */
export function formatRunDuration(
  startedAt: number,
  userMessageCreatedAt: number | undefined,
  completedAt: number | undefined,
): RunDuration | undefined {
  if (!isFiniteNumber(completedAt)) {
    return undefined;
  }
  if (isFiniteNumber(userMessageCreatedAt)) {
    return { label: formatElapsed(completedAt, userMessageCreatedAt), fromPrompt: true };
  }
  return { label: formatElapsed(completedAt, startedAt), fromPrompt: false };
}
