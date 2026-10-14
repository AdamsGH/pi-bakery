import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_FILENAME, defaults, globalConfigPath, loadConfig, projectConfigPath } from "../src/config.js";

/** A throwaway agent directory plus project directory, so no test touches the real one. */
function sandbox(): { agentDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), "auto-suggest-skill-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  return { agentDir, cwd };
}

function writeGlobal(agentDir: string, value: unknown): void {
  writeFileSync(join(agentDir, CONFIG_FILENAME), JSON.stringify(value));
}

function writeProject(cwd: string, value: unknown): void {
  writeFileSync(join(cwd, ".pi", CONFIG_FILENAME), JSON.stringify(value));
}

describe("path helpers", () => {
  it("names the file after the extension", () => {
    expect(globalConfigPath("/agent")).toBe("/agent/auto-suggest-skill.json");
    expect(projectConfigPath("/project")).toBe("/project/.pi/auto-suggest-skill.json");
  });
});

describe("defaults", () => {
  it("is enabled, with the two-entry model preference and the measured gate threshold", () => {
    const config = defaults();
    expect(config.enabled).toBe(true);
    expect(config.prefer).toEqual(["typesafe/jev-latest", "openrouter/~typesafe/jev-latest"]);
    expect(config.threshold).toBe(0.3);
    expect(config.neverSuggest).toEqual([]);
    expect(config.alwaysSuggest).toEqual([]);
    expect(config.debugLog).toBeNull();
  });
});

describe("loadConfig", () => {
  it("returns the defaults when no file exists", () => {
    const { agentDir, cwd } = sandbox();
    const loaded = loadConfig({ cwd, trusted: true, agentDir });
    expect(loaded.config).toEqual(defaults());
    expect(loaded.sources).toEqual([]);
    expect(loaded.error).toBeUndefined();
  });

  it("reads the global file", () => {
    const { agentDir, cwd } = sandbox();
    writeGlobal(agentDir, { threshold: 0.5, neverSuggest: ["legacy-skill"] });
    const loaded = loadConfig({ cwd, trusted: true, agentDir });
    expect(loaded.config.threshold).toBe(0.5);
    expect(loaded.config.neverSuggest).toEqual(["legacy-skill"]);
    expect(loaded.sources[0]?.keys).toEqual(["threshold", "neverSuggest"]);
  });

  it("lets the project file override per key rather than replacing the policy", () => {
    const { agentDir, cwd } = sandbox();
    writeGlobal(agentDir, { threshold: 0.5, neverSuggest: ["a"], alwaysSuggest: ["b"] });
    writeProject(cwd, { threshold: 0.1 });
    const loaded = loadConfig({ cwd, trusted: true, agentDir });
    expect(loaded.config.threshold).toBe(0.1);
    expect(loaded.config.neverSuggest).toEqual(["a"]);
    expect(loaded.config.alwaysSuggest).toEqual(["b"]);
    expect(loaded.sources.map((source) => source.keys)).toEqual([["threshold", "neverSuggest", "alwaysSuggest"], ["threshold"]]);
  });

  it("ignores the project file when the project is not trusted", () => {
    const { agentDir, cwd } = sandbox();
    writeGlobal(agentDir, { threshold: 0.5 });
    writeProject(cwd, { threshold: 0.1 });
    const loaded = loadConfig({ cwd, trusted: false, agentDir });
    expect(loaded.config.threshold).toBe(0.5);
    expect(loaded.sources).toHaveLength(1);
  });

  it("reports a JSON syntax error instead of silently using defaults", () => {
    const { agentDir, cwd } = sandbox();
    writeFileSync(join(agentDir, CONFIG_FILENAME), "{ not json");
    const loaded = loadConfig({ cwd, trusted: true, agentDir });
    expect(loaded.error).toContain("could not read");
    expect(loaded.config).toEqual(defaults());
  });

  it("rejects a non-object file", () => {
    const { agentDir, cwd } = sandbox();
    writeGlobal(agentDir, [1, 2, 3]);
    const loaded = loadConfig({ cwd, trusted: true, agentDir });
    expect(loaded.error).toContain("must contain a JSON object");
  });

  it("warns about unknown keys without failing", () => {
    const { agentDir, cwd } = sandbox();
    writeGlobal(agentDir, { threshold: 0.4, typo: 1 });
    const loaded = loadConfig({ cwd, trusted: true, agentDir });
    expect(loaded.config.threshold).toBe(0.4);
    expect(loaded.warnings.join(" ")).toContain("typo");
  });

  it("ignores an out-of-range threshold rather than clamping it", () => {
    const { agentDir, cwd } = sandbox();
    writeGlobal(agentDir, { threshold: 1.5 });
    const loaded = loadConfig({ cwd, trusted: true, agentDir });
    expect(loaded.config.threshold).toBe(0.3);
    expect(loaded.warnings.join(" ")).toContain("threshold must be a number in [0, 1]");
  });

  it("accepts a threshold of exactly 0 and exactly 1", () => {
    const { agentDir, cwd } = sandbox();
    writeGlobal(agentDir, { threshold: 0 });
    expect(loadConfig({ cwd, trusted: true, agentDir }).config.threshold).toBe(0);
    writeGlobal(agentDir, { threshold: 1 });
    expect(loadConfig({ cwd, trusted: true, agentDir }).config.threshold).toBe(1);
  });

  it("reads model.prefer and rejects an empty list", () => {
    const { agentDir, cwd } = sandbox();
    writeGlobal(agentDir, { model: { prefer: ["opencode/jev-1.13-free"] } });
    expect(loadConfig({ cwd, trusted: true, agentDir }).config.prefer).toEqual(["opencode/jev-1.13-free"]);
    writeGlobal(agentDir, { model: { prefer: [] } });
    const loaded = loadConfig({ cwd, trusted: true, agentDir });
    expect(loaded.config.prefer).toEqual(defaults().prefer);
    expect(loaded.warnings.join(" ")).toContain("model.prefer was empty");
  });

  it("de-duplicates and trims name lists", () => {
    const { agentDir, cwd } = sandbox();
    writeGlobal(agentDir, { neverSuggest: [" a ", "a", "b"] });
    expect(loadConfig({ cwd, trusted: true, agentDir }).config.neverSuggest).toEqual(["a", "b"]);
  });

  it("drops non-string entries from name lists with a warning", () => {
    const { agentDir, cwd } = sandbox();
    writeGlobal(agentDir, { neverSuggest: ["a", 7, null] });
    const loaded = loadConfig({ cwd, trusted: true, agentDir });
    expect(loaded.config.neverSuggest).toEqual(["a"]);
    expect(loaded.warnings.join(" ")).toContain("non-string");
  });

  it("accepts a debugLog path and an explicit null", () => {
    const { agentDir, cwd } = sandbox();
    writeGlobal(agentDir, { debugLog: "/tmp/a.log" });
    expect(loadConfig({ cwd, trusted: true, agentDir }).config.debugLog).toBe("/tmp/a.log");
    writeGlobal(agentDir, { debugLog: null });
    expect(loadConfig({ cwd, trusted: true, agentDir }).config.debugLog).toBeNull();
  });

  it("disables routing only for an explicit false", () => {
    const { agentDir, cwd } = sandbox();
    writeGlobal(agentDir, { enabled: false });
    expect(loadConfig({ cwd, trusted: true, agentDir }).config.enabled).toBe(false);
    writeGlobal(agentDir, { enabled: "no" });
    expect(loadConfig({ cwd, trusted: true, agentDir }).config.enabled).toBe(true);
  });
});
