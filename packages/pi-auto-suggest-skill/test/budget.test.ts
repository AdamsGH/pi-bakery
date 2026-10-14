import { describe, expect, it } from "vitest";
import { CONTEXT_SAFETY, EXCERPT_CHARS, SHORTLIST_SIZE } from "../src/config.js";
import { estimatePayload, estimateTokens, fitsContext } from "../src/budget.js";
import type { ClassifierApi, ClassifierModel, RosterSkill } from "../src/types.js";

function model(contextWindow: number): ClassifierModel<ClassifierApi> {
  return {
    type: "classifier",
    id: "m",
    name: "M",
    provider: "p",
    api: "typesafe-system-one",
    baseUrl: "https://example.invalid/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
  };
}

/** A roster shaped like a real one: 69 skills with descriptions averaging 380 characters. */
function realisticRoster(): RosterSkill[] {
  return Array.from({ length: 69 }, (_, index) => ({
    name: `skill-${index}`,
    description: "x".repeat(380),
    filePath: `/skills/skill-${index}/SKILL.md`,
  }));
}

describe("estimateTokens", () => {
  it("counts ASCII at four characters per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("")).toBe(0);
  });

  it("charges non-ASCII far more per character, because Japanese is expensive", () => {
    expect(estimateTokens("あ")).toBeGreaterThan(estimateTokens("a"));
    expect(estimateTokens("あああ")).toBeGreaterThan(estimateTokens("aaa"));
  });
});

describe("estimatePayload", () => {
  it("is dominated by the roster, since descriptions dwarf names", () => {
    const estimate = estimatePayload(realisticRoster(), "build a deck");
    expect(estimate.rosterTokens).toBeGreaterThan(estimate.taskTokens);
    expect(estimate.rosterTokens).toBeGreaterThan(estimate.rerankTokens);
  });

  it("lands in the band the real 69-skill roster measured", () => {
    // The live roster measured 27,332 characters of names and descriptions, ~7,240 tokens.
    const estimate = estimatePayload(realisticRoster(), "x y z w");
    expect(estimate.totalTokens).toBeGreaterThan(6000);
    expect(estimate.totalTokens).toBeLessThan(9000);
  });

  it("reports the larger of the two stages, since that is what must fit", () => {
    const estimate = estimatePayload(realisticRoster(), "x y z w");
    expect(estimate.totalTokens).toBe(
      Math.ceil(Math.max(estimate.rosterTokens + estimate.taskTokens, estimate.rerankTokens + estimate.taskTokens)),
    );
  });

  it("grows with the roster", () => {
    const small = estimatePayload(realisticRoster().slice(0, 5), "x y z w");
    const large = estimatePayload(realisticRoster(), "x y z w");
    expect(large.totalTokens).toBeGreaterThan(small.totalTokens);
  });

  it("grows with the task text", () => {
    const short = estimatePayload([], "hi");
    const long = estimatePayload([], "x".repeat(4000));
    expect(long.totalTokens).toBeGreaterThan(short.totalTokens);
  });

  it("sizes the rerank stage from the configured excerpt length and shortlist size", () => {
    const estimate = estimatePayload([], "");
    expect(estimate.rerankTokens).toBe(Math.ceil(SHORTLIST_SIZE * estimateTokens("x".repeat(EXCERPT_CHARS))));
  });

  it("still has a floor from the rerank stage when there is no roster and no task", () => {
    // Stage 2 always reads up to SHORTLIST_SIZE excerpts, so the payload never estimates to zero.
    const estimate = estimatePayload([], "");
    expect(estimate.rosterTokens).toBe(0);
    expect(estimate.taskTokens).toBe(0);
    expect(estimate.totalTokens).toBe(Math.ceil(SHORTLIST_SIZE * estimateTokens("x".repeat(EXCERPT_CHARS))));
  });
});

describe("fitsContext", () => {
  const estimate = estimatePayload(realisticRoster(), "x y z w");

  it("rejects the 4096-token tier, which cannot hold a real roster", () => {
    expect(fitsContext(model(4096), estimate)).toBe(false);
  });

  it("rejects the 8192-token tier, which is the respan / kev-4b / laya tier", () => {
    expect(fitsContext(model(8192), estimate)).toBe(false);
  });

  it("accepts the 32000-token tier, which is where jev and opencode sit", () => {
    expect(fitsContext(model(32000), estimate)).toBe(true);
  });

  it("accepts the 65536-token tier", () => {
    expect(fitsContext(model(65536), estimate)).toBe(true);
  });

  it("applies the safety factor rather than the raw estimate", () => {
    const exact = Math.ceil(estimate.totalTokens * CONTEXT_SAFETY);
    expect(fitsContext(model(exact), estimate)).toBe(true);
    expect(fitsContext(model(exact - 1), estimate)).toBe(false);
  });

  it("has no floor: a small roster admits a small model", () => {
    const tiny = estimatePayload([{ name: "a", description: "d", filePath: "/a" }], "x y z w");
    expect(fitsContext(model(4096), tiny)).toBe(true);
  });
});
