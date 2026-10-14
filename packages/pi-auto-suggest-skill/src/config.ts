/**
 * Configuration: one JSON file, read from the global agent directory and overridden per key by a
 * trusted project file.
 *
 *   <agent-dir>/auto-suggest-skill.json          global
 *   <cwd>/.pi/auto-suggest-skill.json            project (only after project trust)
 *
 * Only four values are user-tunable, chosen because a real user would plausibly change them. Every
 * other number the router uses is an internal constant, kept here next to the tunables so the whole
 * policy is readable in one place.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONFIG_FILENAME = "auto-suggest-skill.json";

/**
 * Gate threshold: the mean oriented score over the three gate questions, below which no skill is
 * suggested at all. This is the knob that decides how often the extension speaks up. 0.30 is the
 * value A shipped, adapted from hermes-jev-skills where it was measured.
 */
export const DEFAULT_THRESHOLD = 0.3;

/** Default model preference. Both entries are the same model; TypeSafe direct is tried first. */
export const DEFAULT_PREFER = ["typesafe/jev-latest", "openrouter/~typesafe/jev-latest"] as const;

/**
 * Internal constants. None of these is a config key: they are payload-shape and API-cap values that
 * a user has no basis to tune, and exposing them would make the file a tuning maze.
 */
/** Stage-2 floor: the winner must score at least this, or the round returns no skill. */
export const FITS_THRESHOLD = 0.4;
/** Stage-1 candidates that enter stage 2. */
export const SHORTLIST_SIZE = 3;
/** Characters of each shortlisted `SKILL.md` that stage 2 reads. */
export const EXCERPT_CHARS = 700;
/** The System One question cap; one slot is reserved for `none_of_these` when chunking. */
export const MAX_CHOICES = 255;
/** A chunk whose `none_of_these` probability reaches this is dropped from the shortlist. */
export const NONE_THRESHOLD = 0.5;
/** Concurrent stage-1 chunk calls. */
export const STAGE1_CONCURRENCY = 3;
/** Headroom over the estimated roster payload before a model's context window is accepted. */
export const CONTEXT_SAFETY = 1.5;
/** The task text sent to the model is truncated to this many characters. */
export const MAX_TASK_CHARS = 4000;

export interface AutoSuggestConfig {
  /** Off switch. Not a mode: routing is otherwise always on. */
  enabled: boolean;
  /** Classifier model IDs to try, in order, against what has working credentials. */
  prefer: string[];
  /** Gate threshold in [0, 1]. */
  threshold: number;
  /** Skill names that must never be suggested; removed from the roster before routing. */
  neverSuggest: string[];
  /** Skill names to suggest immediately, in order, skipping the decision call entirely. */
  alwaysSuggest: string[];
  /** When set, one JSON line per decision is appended here. Never contains prompt text. */
  debugLog: string | null;
}

export interface ConfigSource {
  path: string;
  /** Keys this file actually supplied, so a partial project override is visible. */
  keys: string[];
}

export interface LoadedConfig {
  config: AutoSuggestConfig;
  sources: ConfigSource[];
  warnings: string[];
  /** Set when a file exists but could not be used; routing then falls back to defaults. */
  error?: string;
}

export function defaults(): AutoSuggestConfig {
  return {
    enabled: true,
    prefer: [...DEFAULT_PREFER],
    threshold: DEFAULT_THRESHOLD,
    neverSuggest: [],
    alwaysSuggest: [],
    debugLog: null,
  };
}

export function globalConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, CONFIG_FILENAME);
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME);
}

const KEYS = ["enabled", "model", "threshold", "neverSuggest", "alwaysSuggest", "debugLog"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nameList(value: unknown, key: string, warnings: string[]): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    warnings.push(`${key} must be an array of skill names; ignored`);
    return undefined;
  }
  const names = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (names.length !== value.length) warnings.push(`${key} contained non-string or empty entries; they were dropped`);
  return [...new Set(names.map((name) => name.trim()))];
}

/**
 * Read one config file. Returns the keys it actually supplied so a project file can override
 * per key rather than replacing the whole policy. An unreadable file is an error, not a silent
 * fallback: a typo in JSON should be visible, not behave like a missing file.
 */
function readFile(path: string): { values: Partial<AutoSuggestConfig>; keys: string[]; warnings: string[] } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: `could not read ${path}: ${message}` };
  }
  if (!isPlainObject(raw)) return { error: `${path} must contain a JSON object` };

  const warnings: string[] = [];
  const values: Partial<AutoSuggestConfig> = {};
  const supplied: string[] = [];

  const unknown = Object.keys(raw).filter((key) => !(KEYS as readonly string[]).includes(key));
  if (unknown.length > 0) warnings.push(`${path}: unknown key(s) ignored: ${unknown.join(", ")}`);

  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") {
      values.enabled = raw.enabled;
      supplied.push("enabled");
    } else warnings.push("enabled must be a boolean; ignored");
  }
  if (raw.model !== undefined) {
    if (isPlainObject(raw.model)) {
      const prefer = nameList(raw.model.prefer, "model.prefer", warnings);
      if (prefer && prefer.length > 0) {
        values.prefer = prefer;
        supplied.push("model.prefer");
      } else if (prefer) warnings.push("model.prefer was empty; ignored");
    } else warnings.push("model must be an object with a prefer array; ignored");
  }
  if (raw.threshold !== undefined) {
    if (typeof raw.threshold === "number" && Number.isFinite(raw.threshold) && raw.threshold >= 0 && raw.threshold <= 1) {
      values.threshold = raw.threshold;
      supplied.push("threshold");
    } else warnings.push("threshold must be a number in [0, 1]; ignored");
  }
  const never = nameList(raw.neverSuggest, "neverSuggest", warnings);
  if (never) {
    values.neverSuggest = never;
    supplied.push("neverSuggest");
  }
  const always = nameList(raw.alwaysSuggest, "alwaysSuggest", warnings);
  if (always) {
    values.alwaysSuggest = always;
    supplied.push("alwaysSuggest");
  }
  if (raw.debugLog !== undefined) {
    if (raw.debugLog === null) {
      values.debugLog = null;
      supplied.push("debugLog");
    } else if (typeof raw.debugLog === "string" && raw.debugLog.trim().length > 0) {
      values.debugLog = raw.debugLog.trim();
      supplied.push("debugLog");
    } else warnings.push("debugLog must be a non-empty string path or null; ignored");
  }

  return { values, keys: supplied, warnings };
}

export interface LoadConfigOptions {
  cwd: string;
  /** Project config is read only when the project is trusted. */
  trusted: boolean;
  /** Overridable so tests never touch the real agent directory. */
  agentDir?: string;
}

/**
 * Resolve the effective config. The global file is read first; the project file then overrides the
 * keys it actually supplies. A read error in either file is reported and the defaults apply, so a
 * broken config degrades to a working extension rather than a broken one.
 */
export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const config = defaults();
  const sources: ConfigSource[] = [];
  const warnings: string[] = [];
  let error: string | undefined;

  const files = [globalConfigPath(options.agentDir)];
  if (options.trusted) files.push(projectConfigPath(options.cwd));

  for (const path of files) {
    if (!existsSync(path)) continue;
    const result = readFile(path);
    if ("error" in result) {
      error = result.error;
      continue;
    }
    warnings.push(...result.warnings);
    if (result.keys.length === 0) continue;
    Object.assign(config, result.values);
    sources.push({ path, keys: result.keys });
  }

  return { config, sources, warnings, ...(error ? { error } : {}) };
}
