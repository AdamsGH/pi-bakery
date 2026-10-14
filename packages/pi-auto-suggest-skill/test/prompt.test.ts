import { describe, expect, it } from "vitest";
import {
  formatSuggestion,
  GUIDANCE,
  isSkillExpansion,
  SUGGESTION_TYPE,
  trivialTurn,
} from "../src/prompt.js";
import type { Suggestion } from "../src/types.js";

describe("trivialTurn", () => {
  const names = ["commit", "review-code", "writing-subagent-workflows"];

  it("skips an empty or whitespace-only prompt", () => {
    expect(trivialTurn("", names)).toBe(true);
    expect(trivialTurn("   \n ", names)).toBe(true);
  });

  it("skips a slash command, which is not a task", () => {
    expect(trivialTurn("/auto-suggest-skill:status", names)).toBe(true);
    expect(trivialTurn("/compact", names)).toBe(true);
  });

  it("skips a short prompt that names no skill, so a greeting costs nothing", () => {
    expect(trivialTurn("hi", names)).toBe(true);
    expect(trivialTurn("thanks", names)).toBe(true);
    expect(trivialTurn("fix the bug", names)).toBe(true);
  });

  it("routes a short prompt that names a skill", () => {
    expect(trivialTurn("commit", names)).toBe(false);
    expect(trivialTurn("please commit", names)).toBe(false);
    expect(trivialTurn("run writing-subagent-workflows", names)).toBe(false);
  });

  it("routes any long prompt, whether or not it names a skill", () => {
    expect(trivialTurn("please review this diff", names)).toBe(false);
    expect(trivialTurn("create a short pitch deck as pptx", names)).toBe(false);
  });

  it("does not find a name inside a longer word", () => {
    expect(trivialTurn("digital", ["git"])).toBe(true);
    expect(trivialTurn("commit", ["committed"])).toBe(true);
  });

  it("counts words on whitespace runs, not characters", () => {
    expect(trivialTurn("a   b   c")).toBe(true);
    expect(trivialTurn("a   b   c   d")).toBe(false);
  });

  it("treats a missing skill list as no names at all", () => {
    expect(trivialTurn("commit")).toBe(true);
  });
});

describe("isSkillExpansion", () => {
  it("detects the envelope Pi substitutes for /skill:name", () => {
    const prompt = '<skill name="review" location="/skills/review/SKILL.md">\nbody\n</skill>';
    expect(isSkillExpansion(prompt)).toBe(true);
  });

  it("detects an envelope with trailing task arguments", () => {
    const prompt =
      '<skill name="review" location="/s/SKILL.md">\nbody\n</skill>\n\nreview the auth code';
    expect(isSkillExpansion(prompt)).toBe(true);
  });

  it("returns false for ordinary text, which is the regression that null !== undefined caused", () => {
    expect(isSkillExpansion("normal text")).toBe(false);
    expect(isSkillExpansion("")).toBe(false);
    expect(isSkillExpansion("<skill>unquoted</skill>")).toBe(false);
  });
});

describe("formatSuggestion", () => {
  const base: Suggestion = {
    skill: "review-code",
    location: "/skills/review-code/SKILL.md",
    reason: "shortlist winner with fits 0.71",
    gate: 0.83,
    shortlist: ["review-code"],
    fits: { "review-code": 0.71 },
  };

  it("names the skill, its location and why", () => {
    const text = formatSuggestion(base);
    expect(text).toContain("review-code");
    expect(text).toContain("/skills/review-code/SKILL.md");
    expect(text).toContain("shortlist winner with fits 0.71");
  });

  it("invites the model to decline a recommendation that does not fit", () => {
    expect(formatSuggestion(base)).toContain("Ignore this if it does not fit");
  });

  it("returns null when nothing was chosen", () => {
    expect(formatSuggestion({ ...base, skill: null, location: null })).toBeNull();
    expect(formatSuggestion({ ...base, location: null })).toBeNull();
  });
});

describe("prompt constants", () => {
  it("uses a stable custom type and section key", () => {
    expect(SUGGESTION_TYPE).toBe("auto-suggest-skill");
    expect(GUIDANCE.length).toBeGreaterThan(0);
  });

  it("names the missing roster and what to do with a recommendation", () => {
    expect(GUIDANCE).toContain("Skills are not listed in this prompt");
    expect(GUIDANCE).toContain("read its file and follow it");
  });

  it("stays short enough to be worth injecting on every turn", () => {
    // The verbose form this replaced ran to ~200 characters and ~45 words.
    expect(GUIDANCE.length).toBeLessThan(140);
    expect(GUIDANCE.split(/\s+/).length).toBeLessThan(30);
  });
});
