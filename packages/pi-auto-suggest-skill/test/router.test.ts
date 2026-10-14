import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chunkRoster,
  errorCodeFor,
  none,
  pickShortlist,
  RouterError,
  suggest,
} from "../src/router.js";
import type { ClassifierResult, DecisionClient, DecisionStage, RosterSkill } from "../src/types.js";

const roster: RosterSkill[] = [
  { name: "alpha", description: "does alpha things", filePath: "/does-not-exist/alpha/SKILL.md" },
  { name: "beta", description: "does beta things", filePath: "/does-not-exist/beta/SKILL.md" },
  { name: "gamma", description: "does gamma things", filePath: "/does-not-exist/gamma/SKILL.md" },
];

function gate(acts: number, procedure: number, proseSuffices: number) {
  return {
    "gate::acts_on_user_system": { type: "bool" as const, probability: acts },
    "gate::would_follow_documented_procedure": { type: "bool" as const, probability: procedure },
    "gate::prose_suffices": { type: "bool" as const, probability: proseSuffices },
  };
}

function result(answers: Record<string, unknown>): ClassifierResult {
  return {
    api: "typesafe-system-one",
    provider: "typesafe",
    model: "jev-latest",
    answers: answers as ClassifierResult["answers"],
    stopReason: "stop",
    timestamp: 0,
  };
}

/** A client that answers by stage and records the stages it was asked for. */
function stagedClient(rank: ClassifierResult, rerank?: ClassifierResult) {
  const stages: DecisionStage[] = [];
  const client: DecisionClient = {
    async decide(_request, options) {
      const stage = options?.stage ?? "rank";
      stages.push(stage);
      return stage === "rerank" ? (rerank ?? rank) : rank;
    },
  };
  return { client, stages };
}

const rankPicksAlpha = result({
  which: {
    type: "choice",
    choice: "alpha",
    probabilities: { alpha: 0.7, beta: 0.2, gamma: 0.1 },
    confidence: 0.7,
  },
  ...gate(0.9, 0.8, 0.2),
});

describe("errorCodeFor", () => {
  it("maps the failure classes the status report groups by", () => {
    expect(errorCodeFor({ stopReason: "aborted" } as ClassifierResult)).toBe("aborted");
    expect(
      errorCodeFor({
        stopReason: "error",
        errorMessage: "System One API error (401): unauthorized",
      } as ClassifierResult),
    ).toBe("auth");
    expect(
      errorCodeFor({
        stopReason: "error",
        errorMessage: "rate limit exceeded",
      } as ClassifierResult),
    ).toBe("rate_limit");
    expect(
      errorCodeFor({ stopReason: "error", errorMessage: "request timed out" } as ClassifierResult),
    ).toBe("timeout");
    expect(errorCodeFor({ stopReason: "error", errorMessage: "kaboom" } as ClassifierResult)).toBe(
      "error",
    );
  });

  it("never returns provider text", () => {
    const code = errorCodeFor({
      stopReason: "error",
      errorMessage: "secret-looking detail",
    } as ClassifierResult);
    expect(code).toBe("error");
  });
});

describe("none", () => {
  it("is a no-skill result carrying whatever detail the caller has", () => {
    expect(none("why")).toEqual({
      skill: null,
      location: null,
      reason: "why",
      gate: 0,
      shortlist: [],
      fits: {},
    });
    expect(none("why", { gate: 0.2 }).gate).toBe(0.2);
  });
});

describe("chunkRoster", () => {
  it("splits into fixed-size chunks", () => {
    expect(chunkRoster([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("returns one empty chunk for an empty roster, so callers do not special-case it", () => {
    expect(chunkRoster([], 10)).toEqual([[]]);
  });

  it("refuses a size above the API cap", () => {
    expect(() => chunkRoster([1], 256)).toThrow(/exceeds the API cap/);
  });
});

describe("pickShortlist", () => {
  it("keeps the best chunk's ranking order", () => {
    expect(
      pickShortlist(
        [
          [
            ["a", 0.9],
            ["b", 0.5],
          ],
        ],
        [0],
        3,
      ),
    ).toEqual(["a", "b"]);
  });

  it("drops a chunk whose none_of_these pressure reaches the threshold", () => {
    expect(pickShortlist([[["a", 0.9]], [["c", 0.8]]], [0, 0.9], 3)).toEqual(["a"]);
  });

  it("keeps a chunk below the none threshold", () => {
    expect(pickShortlist([[["a", 0.9]], [["c", 0.8]]], [0, 0.4], 3)).toEqual(["a", "c"]);
  });

  it("seats one winner per surviving chunk before filling from the best chunk", () => {
    expect(
      pickShortlist(
        [
          [
            ["a", 0.9],
            ["b", 0.8],
          ],
          [
            ["c", 0.85],
            ["d", 0.7],
          ],
        ],
        [0, 0],
        2,
      ),
    ).toEqual(["a", "c"]);
  });

  it("respects the shortlist size", () => {
    expect(
      pickShortlist(
        [
          [
            ["a", 0.9],
            ["b", 0.8],
            ["c", 0.7],
          ],
        ],
        [0],
        1,
      ),
    ).toEqual(["a"]);
    expect(pickShortlist([[["a", 0.9]]], [0], 0)).toEqual([]);
  });

  it("never repeats a name", () => {
    expect(
      pickShortlist(
        [
          [["a", 0.9]],
          [
            ["a", 0.8],
            ["b", 0.7],
          ],
        ],
        [0, 0],
        3,
      ),
    ).toEqual(["a", "b"]);
  });
});

describe("suggest", () => {
  it("returns nothing for an empty roster without calling the model", async () => {
    const { client, stages } = stagedClient(rankPicksAlpha);
    const suggestion = await suggest(client, "x y z w", [], { threshold: 0.3 });
    expect(suggestion.skill).toBeNull();
    expect(suggestion.reason).toBe("roster empty");
    expect(stages).toEqual([]);
  });

  it("runs both stages and returns the winner", async () => {
    const { client, stages } = stagedClient(
      rankPicksAlpha,
      result({
        which: {
          type: "choice",
          choice: "alpha",
          probabilities: { alpha: 0.8, beta: 0.1, none_of_these: 0.1 },
          confidence: 0.8,
        },
        "fits::alpha": { type: "bool", probability: 0.85 },
        "fits::beta": { type: "bool", probability: 0.1 },
        "fits::gamma": { type: "bool", probability: 0.05 },
      }),
    );
    const suggestion = await suggest(client, "build a deck", roster, { threshold: 0.3 });
    expect(stages).toEqual(["rank", "rerank"]);
    expect(suggestion.skill).toBe("alpha");
    expect(suggestion.location).toBe("/does-not-exist/alpha/SKILL.md");
    expect(suggestion.shortlist).toEqual(["alpha", "beta", "gamma"]);
    expect(suggestion.gate).toBeCloseTo(0.8333, 3);
  });

  it("stops after stage 1 when the gate rejects, which is the whole point of the gate", async () => {
    const { client, stages } = stagedClient(
      result({
        which: {
          type: "choice",
          choice: "alpha",
          probabilities: { alpha: 0.7, beta: 0.2, gamma: 0.1 },
          confidence: 0.7,
        },
        ...gate(0.1, 0.1, 0.9),
      }),
    );
    const suggestion = await suggest(client, "what is 2+2", roster, { threshold: 0.3 });
    expect(stages).toEqual(["rank"]);
    expect(suggestion.skill).toBeNull();
    expect(suggestion.gate).toBeCloseTo(0.1, 3);
    expect(suggestion.reason).toContain("no skill wanted");
  });

  it("inverts prose_suffices when averaging the gate", async () => {
    // acts 0.9, procedure 0.8, prose 0.9 -> oriented 0.9, 0.8, 0.1 -> mean 0.6
    const { client } = stagedClient(
      result({
        which: { type: "choice", choice: "alpha", probabilities: { alpha: 0.7 }, confidence: 0.7 },
        ...gate(0.9, 0.8, 0.9),
      }),
      result({
        which: { type: "choice", choice: "alpha", probabilities: { alpha: 0.9 }, confidence: 0.9 },
        "fits::alpha": { type: "bool", probability: 0.9 },
      }),
    );
    const suggestion = await suggest(client, "build a deck", roster, { threshold: 0.5 });
    expect(suggestion.gate).toBeCloseTo(0.6, 3);
    expect(suggestion.skill).toBe("alpha");
  });

  it("rejects a winner below the fit floor", async () => {
    const { client } = stagedClient(
      rankPicksAlpha,
      result({
        which: {
          type: "choice",
          choice: "alpha",
          probabilities: { alpha: 0.9, beta: 0.05, none_of_these: 0.05 },
          confidence: 0.9,
        },
        "fits::alpha": { type: "bool", probability: 0.2 },
        "fits::beta": { type: "bool", probability: 0.1 },
        "fits::gamma": { type: "bool", probability: 0.1 },
      }),
    );
    const suggestion = await suggest(client, "build a deck", roster, { threshold: 0.3 });
    expect(suggestion.skill).toBeNull();
    expect(suggestion.reason).toContain("fits 0.20 < 0.40");
  });

  it("accepts a winner exactly at the fit floor", async () => {
    const { client } = stagedClient(
      rankPicksAlpha,
      result({
        which: { type: "choice", choice: "alpha", probabilities: { alpha: 0.9 }, confidence: 0.9 },
        "fits::alpha": { type: "bool", probability: 0.4 },
        "fits::beta": { type: "bool", probability: 0.1 },
        "fits::gamma": { type: "bool", probability: 0.1 },
      }),
    );
    expect((await suggest(client, "build a deck", roster, { threshold: 0.3 })).skill).toBe("alpha");
  });

  it("returns nothing when stage 2 picks none_of_these", async () => {
    const { client } = stagedClient(
      rankPicksAlpha,
      result({
        which: {
          type: "choice",
          choice: "none_of_these",
          probabilities: { alpha: 0.3, beta: 0.3, none_of_these: 0.4 },
          confidence: 0.4,
        },
        "fits::alpha": { type: "bool", probability: 0.9 },
        "fits::beta": { type: "bool", probability: 0.9 },
        "fits::gamma": { type: "bool", probability: 0.9 },
      }),
    );
    expect((await suggest(client, "build a deck", roster, { threshold: 0.3 })).reason).toBe(
      "stage 2 picked none: no skill fits",
    );
  });

  it("throws a RouterError with a code when a call fails", async () => {
    const client: DecisionClient = {
      async decide() {
        return {
          api: "typesafe-system-one",
          provider: "t",
          model: "m",
          answers: {},
          stopReason: "error",
          errorMessage: "System One API error (401): nope",
          timestamp: 0,
        };
      },
    };
    await expect(suggest(client, "x y z w", roster, { threshold: 0.3 })).rejects.toBeInstanceOf(
      RouterError,
    );
    await expect(suggest(client, "x y z w", roster, { threshold: 0.3 })).rejects.toMatchObject({
      code: "auth",
    });
  });

  it("chunks above the 254-option cap, keeps the gate in the first chunk only, and always offers none_of_these", async () => {
    const big: RosterSkill[] = Array.from({ length: 300 }, (_, index) => ({
      name: `skill-${index}`,
      description: "d",
      filePath: `/s/${index}`,
    }));
    const seen: Array<{
      stage: DecisionStage;
      options: number;
      hasNone: boolean;
      hasGate: boolean;
    }> = [];
    const client: DecisionClient = {
      async decide(request, options) {
        const criteria =
          request.questions.which.type === "choice" ? request.questions.which.criteria : {};
        seen.push({
          stage: options?.stage ?? "rank",
          options: Object.keys(criteria).length,
          hasNone: "none_of_these" in criteria,
          hasGate: "gate::prose_suffices" in request.questions,
        });
        const probabilities: Record<string, number> = {};
        for (const key of Object.keys(criteria))
          probabilities[key] = key === "none_of_these" ? 0 : 0.5;
        return result({
          which: {
            type: "choice",
            choice: Object.keys(probabilities)[0],
            probabilities,
            confidence: 0.5,
          },
        });
      },
    };
    await suggest(client, "x y z w", big, { threshold: 0 });
    const rank = seen.filter((entry) => entry.stage === "rank");
    expect(rank).toHaveLength(2);
    expect(rank[0]).toMatchObject({ options: 255, hasNone: true, hasGate: true });
    expect(rank[1]).toMatchObject({ options: 47, hasNone: true, hasGate: false });
  });

  it("does not offer none_of_these when the roster fits one chunk", async () => {
    let hasNone: boolean | null = null;
    const client: DecisionClient = {
      async decide(request) {
        const criteria =
          request.questions.which.type === "choice" ? request.questions.which.criteria : {};
        hasNone = "none_of_these" in criteria;
        return result({
          which: { type: "choice", choice: "alpha", probabilities: { alpha: 1 }, confidence: 1 },
          ...gate(0, 0, 1),
        });
      },
    };
    await suggest(client, "x y z w", roster, { threshold: 0.3 });
    expect(hasNone).toBe(false);
  });

  it("reads the shortlisted SKILL.md, stripping its frontmatter, and falls back to the description", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auto-suggest-skill-router-"));
    const skillFile = join(dir, "SKILL.md");
    writeFileSync(
      skillFile,
      "---\nname: real\ndescription: from frontmatter\n---\n\nBODY-MARKER that stage two should see\n",
    );
    const withFile: RosterSkill[] = [
      { name: "real", description: "short description", filePath: skillFile },
    ];

    let rerankCriteria: Record<string, string> = {};
    const client: DecisionClient = {
      async decide(request, options) {
        if (options?.stage === "rerank") {
          rerankCriteria =
            request.questions.which.type === "choice" ? request.questions.which.criteria : {};
          return result({
            which: { type: "choice", choice: "real", probabilities: { real: 1 }, confidence: 1 },
            "fits::real": { type: "bool", probability: 1 },
          });
        }
        return result({
          which: { type: "choice", choice: "real", probabilities: { real: 1 }, confidence: 1 },
          ...gate(0.9, 0.9, 0.1),
        });
      },
    };
    const suggestion = await suggest(client, "build a deck", withFile, { threshold: 0.3 });
    expect(suggestion.skill).toBe("real");
    expect(rerankCriteria.real).toContain("BODY-MARKER");
    expect(rerankCriteria.real).not.toContain("from frontmatter");
  });

  it("falls back to the description alone when the skill file cannot be read", async () => {
    let rerankCriteria: Record<string, string> = {};
    const client: DecisionClient = {
      async decide(request, options) {
        if (options?.stage === "rerank") {
          rerankCriteria =
            request.questions.which.type === "choice" ? request.questions.which.criteria : {};
          return result({
            which: { type: "choice", choice: "alpha", probabilities: { alpha: 1 }, confidence: 1 },
            "fits::alpha": { type: "bool", probability: 1 },
          });
        }
        return result({
          which: { type: "choice", choice: "alpha", probabilities: { alpha: 1 }, confidence: 1 },
          ...gate(0.9, 0.9, 0.1),
        });
      },
    };
    await suggest(client, "build a deck", roster, { threshold: 0.3 });
    expect(rerankCriteria.alpha).toBe("does alpha things");
    expect(rerankCriteria.alpha).not.toContain("SKILL.md:");
  });

  it("sends the task as state.request, so the question wording can refer to it", async () => {
    let state: Record<string, unknown> | null = null;
    const client: DecisionClient = {
      async decide(request) {
        state = request.state;
        return result({
          which: { type: "choice", choice: "alpha", probabilities: { alpha: 1 }, confidence: 1 },
          ...gate(0, 0, 1),
        });
      },
    };
    await suggest(client, "build a deck", roster, { threshold: 0.3 });
    expect(state).toEqual({ request: "build a deck" });
  });
});
