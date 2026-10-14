/**
 * Structural types shared by the router, the model resolver and the extension.
 *
 * Deliberately narrower than `@earendil-works/pi-ai`'s classifier types: the router only needs a
 * client it can ask one question set of, so tests fake it without a model registry, a credential
 * store or a network. `RegistryClient` is the real adapter over `ctx.modelRegistry`.
 */
import type {
  ClassifierAnswer,
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierQuestion,
  ClassifierResult,
  JsonObject,
} from "@earendil-works/pi-ai";

export type {
  ClassifierAnswer,
  ClassifierApi,
  ClassifierContext,
  ClassifierModel,
  ClassifierQuestion,
  ClassifierResult,
  JsonObject,
};

/** The question types this extension builds. */
export type BoolQuestion = Extract<ClassifierQuestion, { type: "bool" }>;
export type ChoiceQuestion = Extract<ClassifierQuestion, { type: "choice" }>;
export type BoolAnswer = Extract<ClassifierAnswer, { type: "bool" }>;
export type ChoiceAnswer = Extract<ClassifierAnswer, { type: "choice" }>;

/** One question set, answered in a single decision call. */
export interface DecisionRequest {
  state: JsonObject;
  questions: Record<string, ClassifierQuestion>;
}

/** Which stage of a round a call belongs to. Recorded so the status report can separate them. */
export type DecisionStage = "rank" | "rerank";

/** The only capability the router needs. `ctx.modelRegistry` is adapted to it in `index.ts`. */
export interface DecisionClient {
  decide(
    request: DecisionRequest,
    options?: { signal?: AbortSignal; stage?: DecisionStage },
  ): Promise<ClassifierResult>;
}

/** A skill as the router sees it: Pi's own `Skill`, minus the fields it never sends. */
export interface RosterSkill {
  name: string;
  description: string;
  filePath: string;
}

/** A routing decision, with enough detail to explain it after the fact. */
export interface Suggestion {
  /** The chosen skill's name, or null when nothing fits. */
  skill: string | null;
  /** Absolute path to the chosen skill's `SKILL.md`. */
  location: string | null;
  /** Human-readable justification, safe to show the model. */
  reason: string;
  /** Mean oriented gate score in [0, 1]; below the threshold no skill is wanted. */
  gate: number;
  /** Stage-1 candidates that reached stage 2. */
  shortlist: string[];
  /** Per-candidate fit score from stage 2. */
  fits: Record<string, number>;
}

/** Why a turn produced no suggestion. Distinct values because the stats report groups by them. */
export type SkipReason = "no-reader" | "trivial" | "no-candidates" | "no-model" | "disabled";
