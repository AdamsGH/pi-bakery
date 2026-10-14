import { describe, expect, it } from "vitest";
import { formatSuggestion, GUIDANCE, isSkillExpansion, SUGGESTION_TYPE, trivialTurn } from "../src/prompt.js";
import type { Suggestion } from "../src/types.js";

describe("trivialTurn", () => {
  it("skips an empty or whitespace-only prompt", () => {
    expect(trivialTurn("")).toBe(true);
    expect(trivialTurn("   \n ")).toBe(true);
  });

  it("skips a slash command, which is not a task", () => {
    expect(trivialTurn("/auto-suggest-skill:status")).toBe(true);
    expect(trivialTurn("/compact")).toBe(true);
  });

  it("skips prompts of three words or fewer", () => {
    expect(trivialTurn("thanks")).toBe(true);
    expect(trivialTurn("fix the bug")).toBe(true);
    expect(trivialTurn("what is 2+2?")).toBe(true);
  });

  it("routes prompts of four words or more", () => {
    expect(trivialTurn("please review this diff")).toBe(false);
    expect(trivialTurn("create a short pitch deck as pptx")).toBe(false);
  });

  it("counts on whitespace runs, not characters", () => {
    expect(trivialTurn("a   b   c")).toBe(true);
    expect(trivialTurn("a   b   c   d")).toBe(false);
  });
});

describe("isSkillExpansion", () => {
  it("detects the envelope Pi substitutes for /skill:name", () => {
    const prompt = '<skill name="review" location="/skills/review/SKILL.md">\nbody\n</skill>';
    expect(isSkillExpansion(prompt)).toBe(true);
  });

  it("detects an envelope with trailing task arguments", () => {
    const prompt = '<skill name="review" location="/s/SKILL.md">\nbody\n</skill>\n\nreview the auth code';
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

  it("tells the model what to do when no recommendation arrives", () => {
    expect(GUIDANCE).toContain("If none is present, continue without a skill");
  });
});
