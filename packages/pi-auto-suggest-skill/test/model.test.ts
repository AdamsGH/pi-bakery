import { describe, expect, it } from "vitest";
import {
  isResolvedModel,
  parsePreference,
  resolveModel,
  type ClassifierRegistry,
} from "../src/model.js";
import type { ClassifierApi, ClassifierModel, RosterSkill } from "../src/types.js";

const roster: RosterSkill[] = [
  { name: "alpha", description: "does alpha things", filePath: "/a" },
  { name: "beta", description: "does beta things", filePath: "/b" },
];

/** A roster big enough that small-context models must be rejected. */
const bigRoster: RosterSkill[] = Array.from({ length: 69 }, (_, index) => ({
  name: `skill-${index}`,
  description: "x".repeat(380),
  filePath: `/s/${index}`,
}));

function model(
  provider: string,
  id: string,
  contextWindow: number,
): ClassifierModel<ClassifierApi> {
  return {
    type: "classifier",
    id,
    name: id,
    provider,
    api: "typesafe-system-one",
    baseUrl: "https://example.invalid/v1",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
  };
}

function registryOf(models: readonly ClassifierModel<ClassifierApi>[]): ClassifierRegistry {
  return { getAvailableOfType: async () => models };
}

describe("parsePreference", () => {
  it("splits on the first slash only, because model ids contain slashes", () => {
    expect(parsePreference("typesafe/jev-latest")).toEqual({
      provider: "typesafe",
      id: "jev-latest",
    });
    expect(parsePreference("openrouter/typesafe/jev-1.13")).toEqual({
      provider: "openrouter",
      id: "typesafe/jev-1.13",
    });
    expect(parsePreference("openrouter/~typesafe/jev-latest")).toEqual({
      provider: "openrouter",
      id: "~typesafe/jev-latest",
    });
    expect(parsePreference("cloudflare-workers-ai/@cf/cloudflare/clef")).toEqual({
      provider: "cloudflare-workers-ai",
      id: "@cf/cloudflare/clef",
    });
  });

  it("rejects an entry with no provider or no id", () => {
    expect(parsePreference("jev-latest")).toBeNull();
    expect(parsePreference("typesafe/")).toBeNull();
    expect(parsePreference("/jev-latest")).toBeNull();
    expect(parsePreference("")).toBeNull();
  });
});

describe("resolveModel", () => {
  it("takes the first preference entry that resolves", async () => {
    const registry = registryOf([
      model("typesafe", "jev-latest", 64000),
      model("openrouter", "~typesafe/jev-latest", 32000),
    ]);
    const resolved = await resolveModel({
      registry,
      prefer: ["typesafe/jev-latest", "openrouter/~typesafe/jev-latest"],
      roster,
      task: "x y z w",
    });
    expect(isResolvedModel(resolved)).toBe(true);
    if (!isResolvedModel(resolved)) return;
    expect(resolved.model.id).toBe("jev-latest");
    expect(resolved.preferred).toBe("typesafe/jev-latest");
    expect(resolved.skipped).toEqual([]);
  });

  it("falls through to the next entry when the first has no credentials", async () => {
    const registry = registryOf([model("openrouter", "~typesafe/jev-latest", 32000)]);
    const resolved = await resolveModel({
      registry,
      prefer: ["typesafe/jev-latest", "openrouter/~typesafe/jev-latest"],
      roster,
      task: "x y z w",
    });
    expect(isResolvedModel(resolved) && resolved.model.provider).toBe("openrouter");
    expect(isResolvedModel(resolved) && resolved.skipped[0]).toMatchObject({
      id: "typesafe/jev-latest",
      reason: "not-credentialed",
    });
  });

  it("rejects a credentialed model whose context cannot hold the roster", async () => {
    const registry = registryOf([model("typesafe", "tiny", 4096)]);
    const resolved = await resolveModel({
      registry,
      prefer: ["typesafe/tiny"],
      roster: bigRoster,
      task: "x y z w",
    });
    expect(isResolvedModel(resolved)).toBe(false);
    if (isResolvedModel(resolved)) return;
    expect(resolved.skipped[0]?.reason).toBe("context-too-small");
    expect(resolved.allTooSmall).toBe(true);
    expect(resolved.error).toContain("too small");
  });

  it("rejects the 8192 tier for a real roster", async () => {
    const registry = registryOf([model("openrouter", "jaredpalmer/kev-4b", 8192)]);
    const resolved = await resolveModel({
      registry,
      prefer: ["openrouter/jaredpalmer/kev-4b"],
      roster: bigRoster,
      task: "x y z w",
    });
    expect(isResolvedModel(resolved)).toBe(false);
  });

  it("skips a too-small entry but still uses a later viable one", async () => {
    const registry = registryOf([
      model("typesafe", "tiny", 4096),
      model("typesafe", "jev-latest", 64000),
    ]);
    const resolved = await resolveModel({
      registry,
      prefer: ["typesafe/tiny", "typesafe/jev-latest"],
      roster: bigRoster,
      task: "x y z w",
    });
    expect(isResolvedModel(resolved) && resolved.model.id).toBe("jev-latest");
    expect(isResolvedModel(resolved) && resolved.skipped).toHaveLength(1);
  });

  it("admits a small model for a small roster, since there is no floor", async () => {
    const registry = registryOf([model("typesafe", "tiny", 4096)]);
    const resolved = await resolveModel({
      registry,
      prefer: ["typesafe/tiny"],
      roster,
      task: "x y z w",
    });
    expect(isResolvedModel(resolved)).toBe(true);
  });

  it("reports a malformed preference entry rather than throwing", async () => {
    const registry = registryOf([model("typesafe", "jev-latest", 64000)]);
    const resolved = await resolveModel({
      registry,
      prefer: ["jev-latest"],
      roster,
      task: "x y z w",
    });
    expect(isResolvedModel(resolved)).toBe(false);
    if (isResolvedModel(resolved)) return;
    expect(resolved.skipped[0]?.detail).toBe("not a provider/id entry");
  });

  it("reports an empty preference list distinctly", async () => {
    const resolved = await resolveModel({
      registry: registryOf([]),
      prefer: [],
      roster,
      task: "x",
    });
    expect(isResolvedModel(resolved)).toBe(false);
    if (isResolvedModel(resolved)) return;
    expect(resolved.error).toBe("model.prefer is empty");
  });

  it("reports no credentials when nothing in the catalog matches", async () => {
    const resolved = await resolveModel({
      registry: registryOf([]),
      prefer: ["typesafe/jev-latest"],
      roster,
      task: "x",
    });
    expect(isResolvedModel(resolved)).toBe(false);
    if (isResolvedModel(resolved)) return;
    expect(resolved.error).toBe("no preferred model has working credentials");
    expect(resolved.availableCount).toBe(0);
  });

  it("survives a registry that throws, which classify() never does", async () => {
    const registry: ClassifierRegistry = {
      getAvailableOfType: async () => {
        throw new Error("ModelsError: credential store read failed");
      },
    };
    const resolved = await resolveModel({
      registry,
      prefer: ["typesafe/jev-latest"],
      roster,
      task: "x",
    });
    expect(isResolvedModel(resolved)).toBe(false);
    if (isResolvedModel(resolved)) return;
    expect(resolved.error).toContain("could not list classifier models");
  });

  it("carries the payload estimate so the status report can explain a rejection", async () => {
    const registry = registryOf([model("typesafe", "jev-latest", 64000)]);
    const resolved = await resolveModel({
      registry,
      prefer: ["typesafe/jev-latest"],
      roster: bigRoster,
      task: "x y z w",
    });
    expect(isResolvedModel(resolved) && resolved.estimate.totalTokens).toBeGreaterThan(6000);
  });
});
