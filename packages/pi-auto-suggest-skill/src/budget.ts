/**
 * Payload size estimation, used to reject classifier models whose context window cannot hold the
 * roster.
 *
 * This exists because the catalog contains models that would fail on payload size rather than on
 * judgement: `respan/span-01*` declare a 4096-token context and `jaredpalmer/kev-4b` and
 * `convaiinnovations/laya*` declare 8192, against a roster that measures ~7,240 tokens before the
 * task text. Trying one in preference order would produce a provider error on every prompt, which
 * looks like the extension being broken.
 *
 * The estimate is computed from the actual roster rather than a fixed floor, so it tracks a growing
 * roster and a more verbose one. It is a heuristic: characters are split ASCII and non-ASCII
 * because Japanese costs roughly three times as many tokens per character as English, and the
 * constants below were fitted against this machine's 69-skill roster, which measured 27,332
 * characters of names and descriptions (~7,240 tokens).
 */
import type { ClassifierApi, ClassifierModel } from "./types.js";
import { CONTEXT_SAFETY, EXCERPT_CHARS, SHORTLIST_SIZE } from "./config.js";
import type { RosterSkill } from "./types.js";

/** Tokens per character for ASCII text. */
const ASCII_PER_TOKEN = 4;
/** Tokens per character for CJK and other non-ASCII text. */
const NON_ASCII_PER_TOKEN = 1.3;

/** Rough token count for a string, splitting ASCII from non-ASCII. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const character of text) {
    if (character.codePointAt(0)! < 128) ascii++;
    else other++;
  }
  return ascii / ASCII_PER_TOKEN + other / NON_ASCII_PER_TOKEN;
}

/** What one decision call is expected to carry. */
export interface PayloadEstimate {
  /** Skill names and descriptions, the dominant term. */
  rosterTokens: number;
  /** The truncated task text. */
  taskTokens: number;
  /** The shortlisted `SKILL.md` excerpts read for stage 2. */
  rerankTokens: number;
  /** The sum, rounded up. */
  totalTokens: number;
}

/**
 * Estimate the largest payload any single stage of one routing round will send.
 *
 * Stage 1 carries the whole roster; stage 2 carries only the excerpts. The larger of the two is
 * what the context window has to hold, so the result is their maximum plus the task text.
 */
export function estimatePayload(roster: readonly RosterSkill[], task: string): PayloadEstimate {
  const rosterTokens = roster.reduce(
    (sum, skill) => sum + estimateTokens(skill.name) + estimateTokens(skill.description),
    0,
  );
  const taskTokens = estimateTokens(task);
  const rerankTokens = SHORTLIST_SIZE * estimateTokens("x".repeat(EXCERPT_CHARS));
  const stage1 = rosterTokens + taskTokens;
  const stage2 = rerankTokens + taskTokens;
  return {
    rosterTokens: Math.ceil(rosterTokens),
    taskTokens: Math.ceil(taskTokens),
    rerankTokens: Math.ceil(rerankTokens),
    totalTokens: Math.ceil(Math.max(stage1, stage2)),
  };
}

/**
 * Whether a model's declared context window can hold the payload with headroom. The safety factor
 * scales with the estimate, so it is not a floor: a small roster admits a small model.
 */
export function fitsContext(model: ClassifierModel<ClassifierApi>, estimate: PayloadEstimate): boolean {
  return model.contextWindow >= estimate.totalTokens * CONTEXT_SAFETY;
}
