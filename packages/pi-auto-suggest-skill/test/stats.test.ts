import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendDebugLog,
  applyRound,
  applySkip,
  counterPath,
  emptyLifetime,
  emptyTally,
  outcomeFor,
  percentile,
  readLifetime,
  renderStatus,
  writeLifetime,
  type LifetimeState,
  type RoundRecord,
  type StatusInput,
} from "../src/stats.js";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "auto-suggest-skill-stats-"));
}

function round(fields: Partial<RoundRecord> = {}): RoundRecord {
  return {
    at: 1_700_000_000_000,
    outcome: "suggested",
    apiCalls: 2,
    rankCalls: 1,
    rerankCalls: 1,
    inputTokens: 7000,
    costUsd: 0.001,
    latencyMs: 400,
    ...fields,
  };
}

describe("applyRound", () => {
  it("counts rounds, calls and outcomes separately", () => {
    const tally = emptyTally();
    applyRound(tally, round({ outcome: "suggested" }));
    applyRound(
      tally,
      round({ outcome: "none", latencyMs: 300, costUsd: 0.0008, inputTokens: 5000 }),
    );
    applyRound(tally, round({ outcome: "failed", latencyMs: 900, costUsd: null, inputTokens: 0 }));
    expect(tally.rounds).toBe(3);
    expect(tally.apiCalls).toBe(6);
    expect(tally.rankCalls).toBe(3);
    expect(tally.rerankCalls).toBe(3);
    expect([tally.suggested, tally.none, tally.failed]).toEqual([1, 1, 1]);
    expect(tally.inputTokens).toBe(12_000);
  });

  it("flags an unpriced model and stops accumulating a total", () => {
    const tally = emptyTally();
    applyRound(tally, round({ costUsd: 0.001 }));
    expect(tally.anyUnpriced).toBe(false);
    applyRound(tally, round({ costUsd: null }));
    expect(tally.anyUnpriced).toBe(true);
  });

  it("counts a round that made no API call, such as an alwaysSuggest override", () => {
    const tally = emptyTally();
    applyRound(
      tally,
      round({
        apiCalls: 0,
        rankCalls: 0,
        rerankCalls: 0,
        inputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
      }),
    );
    expect(tally.rounds).toBe(1);
    expect(tally.apiCalls).toBe(0);
    expect(tally.suggested).toBe(1);
  });

  it("caps stored latencies so the file cannot grow without bound", () => {
    const tally = emptyTally();
    for (let index = 0; index < 2500; index++) applyRound(tally, round({ latencyMs: index }));
    expect(tally.latencies.length).toBeLessThanOrEqual(2000);
    expect(tally.rounds).toBe(2500);
  });
});

describe("applySkip", () => {
  it("counts a turn that made no decision call", () => {
    const tally = emptyTally();
    applySkip(tally);
    applySkip(tally);
    expect(tally.skipped).toBe(2);
    expect(tally.rounds).toBe(0);
  });
});

describe("percentile", () => {
  it("uses nearest rank", () => {
    expect(percentile([400, 300, 900], 0.5)).toBe(400);
    expect(percentile([100, 200, 300, 400], 0.5)).toBe(200);
    expect(percentile([100, 200, 300, 400], 0.95)).toBe(400);
  });

  it("is 0 for an empty set", () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it("does not reorder the caller's array", () => {
    const values = [3, 1, 2];
    percentile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe("counterPath", () => {
  it("lives beside the config in the agent directory", () => {
    expect(counterPath("/agent")).toBe("/agent/auto-suggest-skill-stats.json");
  });
});

describe("lifetime persistence", () => {
  it("round-trips a tally", () => {
    const dir = sandbox();
    const path = join(dir, "stats.json");
    const state = emptyLifetime(1_700_000_000_000);
    applyRound(state, round({ outcome: "none" }));
    state.sessionIds.push("session-a");
    writeLifetime(path, state);
    const loaded = readLifetime(path);
    expect(loaded.rounds).toBe(1);
    expect(loaded.none).toBe(1);
    expect(loaded.sessionIds).toEqual(["session-a"]);
    expect(loaded.firstSeenAt).toBe(1_700_000_000_000);
  });

  it("writes a private file", () => {
    const dir = sandbox();
    const path = join(dir, "nested", "stats.json");
    writeLifetime(path, emptyLifetime(1));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("treats a missing file as a fresh lifetime", () => {
    const loaded = readLifetime(join(sandbox(), "absent.json"));
    expect(loaded.rounds).toBe(0);
    expect(loaded.version).toBe(1);
  });

  it("treats a corrupt file as a fresh lifetime rather than failing", () => {
    const dir = sandbox();
    const path = join(dir, "stats.json");
    writeFileSync(path, "{ not json");
    expect(readLifetime(path).rounds).toBe(0);
  });

  it("rejects an unknown version", () => {
    const dir = sandbox();
    const path = join(dir, "stats.json");
    writeFileSync(path, JSON.stringify({ version: 99, rounds: 500 }));
    expect(readLifetime(path).rounds).toBe(0);
  });

  it("drops non-numeric latencies from a hand-edited file", () => {
    const dir = sandbox();
    const path = join(dir, "stats.json");
    writeFileSync(
      path,
      JSON.stringify({ version: 1, rounds: 1, latencies: [100, "x", null, 200] }),
    );
    expect(readLifetime(path).latencies).toEqual([100, 200]);
  });

  it("does not leave a temp file behind", () => {
    const dir = sandbox();
    const path = join(dir, "stats.json");
    writeLifetime(path, emptyLifetime(1));
    expect(() => readFileSync(`${path}.tmp`, "utf8")).toThrow();
  });
});

describe("appendDebugLog", () => {
  it("appends one JSON line per call and never the prompt", () => {
    const dir = sandbox();
    const path = join(dir, "nested", "debug.log");
    appendDebugLog(path, {
      at: 0,
      stage: "rank",
      model: "typesafe/jev-latest",
      latencyMs: 400,
      inputTokens: 7000,
      stopReason: "stop",
    });
    appendDebugLog(path, {
      at: 0,
      stage: "rerank",
      model: "typesafe/jev-latest",
      latencyMs: 300,
      inputTokens: 5000,
      stopReason: "error",
      errorCode: "auth",
    });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({
      stage: "rank",
      model: "typesafe/jev-latest",
      stopReason: "stop",
    });
    expect(JSON.parse(lines[1]!)).toMatchObject({ stage: "rerank", errorCode: "auth" });
    expect(Object.keys(first)).not.toContain("prompt");
  });

  it("does not throw when the path is unwritable", () => {
    expect(() =>
      appendDebugLog("/proc/definitely/not/writable/log", {
        at: 0,
        stage: "rank",
        model: "m",
        latencyMs: 1,
        inputTokens: 1,
        stopReason: "stop",
      }),
    ).not.toThrow();
  });
});

describe("outcomeFor", () => {
  it("labels a round by whether it chose a skill", () => {
    expect(
      outcomeFor({ skill: "a", location: "/a", reason: "", gate: 1, shortlist: [], fits: {} }),
    ).toBe("suggested");
    expect(
      outcomeFor({ skill: null, location: null, reason: "", gate: 0, shortlist: [], fits: {} }),
    ).toBe("none");
  });
});

describe("renderStatus", () => {
  const session = emptyTally();
  applyRound(
    session,
    round({
      outcome: "suggested",
      latencyMs: 438,
      inputTokens: 12_480,
      costUsd: null,
      gate: 0.83,
      shortlist: ["review-code", "tdd"],
      winner: "review-code",
      winnerFits: 0.71,
    }),
  );

  const lifetime: LifetimeState = {
    ...emptyLifetime(Date.parse("2026-10-13T00:00:00Z")),
    rounds: 381,
    apiCalls: 496,
    suggested: 97,
    none: 241,
    failed: 43,
    skipped: 47,
    inputTokens: 331_204,
    costUsd: 0.0553,
    latencies: [388],
    sessionIds: ["a", "b"],
  };

  const last: RoundRecord = {
    at: Date.parse("2026-10-13T14:02:11Z"),
    outcome: "suggested",
    apiCalls: 2,
    rankCalls: 1,
    rerankCalls: 1,
    inputTokens: 12_480,
    costUsd: null,
    latencyMs: 438,
    gate: 0.83,
    shortlist: ["review-code", "tdd"],
    winner: "review-code",
    winnerFits: 0.71,
  };

  /** A complete report input, so each test overrides only what it is about. */
  function input(overrides: Partial<StatusInput> = {}): StatusInput {
    return {
      session,
      lifetime,
      last,
      lastModel: "typesafe/jev-latest",
      lastRosterSize: 67,
      modelError: null,
      lastSkip: null,
      configSources: [],
      configError: null,
      ...overrides,
    };
  }

  it("shows session and lifetime side by side", () => {
    const text = renderStatus(input());
    expect(text).toContain("1 session / 381 lifetime");
    expect(text).toContain("metric");
    expect(text).toContain("25% (97/381)");
  });

  it("says cost is unavailable rather than printing a misleading zero", () => {
    expect(renderStatus(input())).toContain("cost n/a");
  });

  it("prints a real cost when every round was priced", () => {
    const priced = emptyTally();
    applyRound(priced, round({ costUsd: 0.0021 }));
    const text = renderStatus(input({ session: priced, last: null }));
    expect(text).toContain("$0.0021");
    expect(text).not.toContain("cost n/a");
  });

  it("reports the last round's model, roster size, gate, shortlist and winner", () => {
    const text = renderStatus(input());
    expect(text).toContain("typesafe/jev-latest");
    expect(text).toContain("roster of 67");
    expect(text).toContain("gate       0.83");
    expect(text).toContain("[review-code, tdd]");
    expect(text).toContain("suggested review-code 0.71");
  });

  it("explains a failure with its code", () => {
    const failed: RoundRecord = {
      ...last,
      outcome: "failed",
      errorCode: "auth",
      reason: "System One API error (401)",
    };
    expect(renderStatus(input({ last: failed }))).toContain("failed auth");
  });

  it("says so when nothing has run yet", () => {
    const text = renderStatus(
      input({
        session: emptyTally(),
        lifetime: emptyLifetime(1),
        last: null,
        lastSkip: "no-reader",
      }),
    );
    expect(text).toContain("(none yet this session)");
    expect(text).toContain("skipped    no-reader");
  });

  it("surfaces a model-resolution failure and the config sources", () => {
    const text = renderStatus(
      input({
        last: null,
        lastModel: null,
        lastRosterSize: null,
        modelError: "no preferred model has working credentials",
        lastSkip: "no-model",
        configSources: ["/agent/auto-suggest-skill.json (threshold)"],
      }),
    );
    expect(text).toContain("no preferred model has working credentials");
    expect(text).toContain("/agent/auto-suggest-skill.json");
  });

  it("surfaces a config error", () => {
    const text = renderStatus(
      input({ last: null, configError: "could not read /agent/auto-suggest-skill.json" }),
    );
    expect(text).toContain("could not read");
  });

  it("never prints the prompt text", () => {
    expect(renderStatus(input())).not.toContain("state.request");
  });
});
