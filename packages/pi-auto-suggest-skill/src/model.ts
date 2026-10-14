/**
 * Choosing which classifier model to use.
 *
 * Pi has no preference mechanism for classifier models: `settings.json`'s `enabledModels` scopes
 * chat models only, `defaultModel` is a chat model, and the only classifier-specific availability
 * rule in the whole of Pi is OpenAI's, which hides `gpt-6-luna` under a ChatGPT OAuth credential
 * because the Decisions API rejects it. Every other classifier extension hardcodes a model ID.
 *
 * So the preference is ours. `ctx.modelRegistry.getAvailableOfType("classifier")` gives membership
 * and nothing else — the order it returns is provider registration order, which is neither
 * alphabetical, nor by price, nor by quality — so the order comes from `model.prefer`.
 *
 * A model ID is written `provider/id` and split on the FIRST slash only, because ids contain
 * slashes: `openrouter/typesafe/jev-1.13` is provider `openrouter` with id `typesafe/jev-1.13`.
 */
import type { ClassifierApi, ClassifierModel, RosterSkill } from "./types.js";
import { estimatePayload, fitsContext, type PayloadEstimate } from "./budget.js";

/** The one registry capability this module needs, so tests fake it without credentials. */
export interface ClassifierRegistry {
  getAvailableOfType(
    type: "classifier",
    provider?: string,
    options?: { signal?: AbortSignal },
  ): Promise<readonly ClassifierModel<ClassifierApi>[]>;
}

/** Why a preferred model was not used. Surfaced by the status command. */
export type ModelSkipReason = "not-credentialed" | "context-too-small";

export interface ModelSkip {
  id: string;
  reason: ModelSkipReason;
  detail: string;
}

export interface ResolvedModel {
  model: ClassifierModel<ClassifierApi>;
  /** The preference entry that resolved, verbatim. */
  preferred: string;
  skipped: ModelSkip[];
  estimate: PayloadEstimate;
  /** How many credentialed classifier models were visible at all. */
  availableCount: number;
}

export interface ModelResolutionFailure {
  error: string;
  skipped: ModelSkip[];
  availableCount: number;
  /** Set when credentials resolved but every candidate was rejected on context size. */
  allTooSmall: boolean;
}

/** Split a `provider/id` preference entry on the first slash. */
export function parsePreference(entry: string): { provider: string; id: string } | null {
  const trimmed = entry.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}

/**
 * Resolve the first preferred model that both has working credentials and can hold the payload.
 *
 * `getAvailableOfType` is the one call in this extension that can reject — unlike `classify()`,
 * which never rejects — because a credential-store read or an auth check can throw a `ModelsError`.
 * So it is wrapped, and a failure is reported rather than propagated.
 */
export async function resolveModel(options: {
  registry: ClassifierRegistry;
  prefer: readonly string[];
  roster: readonly RosterSkill[];
  task: string;
  signal?: AbortSignal;
}): Promise<ResolvedModel | ModelResolutionFailure> {
  const { registry, prefer, roster, task, signal } = options;
  const estimate = estimatePayload(roster, task);

  let available: readonly ClassifierModel<ClassifierApi>[];
  try {
    available = await registry.getAvailableOfType("classifier", undefined, signal ? { signal } : {});
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `could not list classifier models: ${message}`, skipped: [], availableCount: 0, allTooSmall: false };
  }

  const byId = new Map(available.map((model) => [`${model.provider}/${model.id}`, model]));
  const skipped: ModelSkip[] = [];

  for (const entry of prefer) {
    const parsed = parsePreference(entry);
    if (!parsed) {
      skipped.push({ id: entry, reason: "not-credentialed", detail: "not a provider/id entry" });
      continue;
    }
    const model = byId.get(entry.trim());
    if (!model) {
      skipped.push({ id: entry, reason: "not-credentialed", detail: "no working credentials, or not in the catalog" });
      continue;
    }
    if (!fitsContext(model, estimate)) {
      skipped.push({
        id: entry,
        reason: "context-too-small",
        detail: `needs ~${estimate.totalTokens} tokens, model declares ${model.contextWindow}`,
      });
      continue;
    }
    return { model, preferred: entry.trim(), skipped, estimate, availableCount: available.length };
  }

  const allTooSmall =
    skipped.length > 0 && skipped.every((entry) => entry.reason === "context-too-small");
  return {
    error:
      prefer.length === 0
        ? "model.prefer is empty"
        : allTooSmall
          ? `every preferred model is too small for this roster (~${estimate.totalTokens} tokens)`
          : "no preferred model has working credentials",
    skipped,
    availableCount: available.length,
    allTooSmall,
  };
}

export function isResolvedModel(
  result: ResolvedModel | ModelResolutionFailure,
): result is ResolvedModel {
  return "model" in result;
}
