/**
 * Decision accounting: a per-session tally, a persisted lifetime tally, an optional debug log, and
 * the `/auto-suggest-skill:status` report.
 *
 * The unit of account is a **routing round**, not a raw API call. A round makes one or two calls
 * (a chunked rank, then a rerank) and only the round has an outcome, so counting calls would make
 * "suggested" and "failed" meaningless — a successful round would be two calls, one of which
 * "failed" to decide anything. API calls are still counted, as their own row, because that is what
 * costs money.
 *
 * The counter file lives beside the config in the agent directory and is deliberately global rather
 * than project-scoped: "calls made so far" is a machine-lifetime figure, not a per-project one.
 * Writes are atomic (temp file plus rename) at mode 0600.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { DecisionStage, SkipReason, Suggestion } from "./types.js";

export const COUNTER_FILENAME = "auto-suggest-skill-stats.json";

export type Outcome = "suggested" | "none" | "failed";

/** One finished routing round. */
export interface RoundRecord {
  at: number;
  outcome: Outcome;
  /** Decision calls this round made. */
  apiCalls: number;
  rankCalls: number;
  rerankCalls: number;
  inputTokens: number;
  /** Null when any call in the round had no catalog price, so a total would be misleading. */
  costUsd: number | null;
  latencyMs: number;
  gate?: number;
  shortlist?: string[];
  winner?: string;
  winnerFits?: number;
  reason?: string;
  errorCode?: string;
}

/** One decision call, as written to the debug log. */
export interface CallLogEntry {
  at: number;
  stage: DecisionStage;
  model: string;
  latencyMs: number;
  inputTokens: number;
  stopReason: string;
  errorCode?: string;
}

/** A tally over a set of rounds. Session and lifetime are both this shape. */
export interface Tally {
  rounds: number;
  apiCalls: number;
  rankCalls: number;
  rerankCalls: number;
  suggested: number;
  none: number;
  failed: number;
  skipped: number;
  inputTokens: number;
  costUsd: number;
  /** True when at least one round had an unpriced model. */
  anyUnpriced: boolean;
  /** Round latencies in milliseconds, capped so the file cannot grow without bound. */
  latencies: number[];
}

/** The persisted lifetime state. */
export interface LifetimeState extends Tally {
  version: 1;
  firstSeenAt: number;
  /** Distinct session ids seen, so the report can say "over N sessions". */
  sessionIds: string[];
}

export function emptyTally(): Tally {
  return {
    rounds: 0,
    apiCalls: 0,
    rankCalls: 0,
    rerankCalls: 0,
    suggested: 0,
    none: 0,
    failed: 0,
    skipped: 0,
    inputTokens: 0,
    costUsd: 0,
    anyUnpriced: false,
    latencies: [],
  };
}

export function emptyLifetime(now: number): LifetimeState {
  return { version: 1, firstSeenAt: now, sessionIds: [], ...emptyTally() };
}

/** Round latencies kept for percentile reporting; beyond this the oldest are dropped. */
const MAX_LATENCIES = 2000;
/** Distinct session ids kept. */
const MAX_SESSIONS = 5000;

export function applyRound(tally: Tally, record: RoundRecord): void {
  tally.rounds++;
  tally.apiCalls += record.apiCalls;
  tally.rankCalls += record.rankCalls;
  tally.rerankCalls += record.rerankCalls;
  if (record.outcome === "suggested") tally.suggested++;
  else if (record.outcome === "none") tally.none++;
  else tally.failed++;
  tally.inputTokens += record.inputTokens;
  if (record.costUsd === null) tally.anyUnpriced = true;
  else tally.costUsd += record.costUsd;
  tally.latencies.push(record.latencyMs);
  if (tally.latencies.length > MAX_LATENCIES) {
    tally.latencies.splice(0, tally.latencies.length - MAX_LATENCIES);
  }
}

/** A turn that made no decision call at all. */
export function applySkip(tally: Tally): void {
  tally.skipped++;
}

/** Nearest-rank percentile over a copy, so the tally is not reordered. */
export function percentile(latencies: readonly number[], fraction: number): number {
  if (latencies.length === 0) return 0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

export function counterPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, COUNTER_FILENAME);
}

/**
 * Read the lifetime tally. A missing file is a fresh lifetime; a corrupt one is also treated as
 * fresh, because refusing to record statistics is worse than losing them.
 */
export function readLifetime(path: string): LifetimeState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LifetimeState>;
    if (parsed.version !== 1) return emptyLifetime(Date.now());
    const base = emptyLifetime(typeof parsed.firstSeenAt === "number" ? parsed.firstSeenAt : Date.now());
    return {
      ...base,
      ...parsed,
      version: 1,
      latencies: Array.isArray(parsed.latencies) ? parsed.latencies.filter((n) => typeof n === "number") : [],
      sessionIds: Array.isArray(parsed.sessionIds) ? parsed.sessionIds.filter((s) => typeof s === "string") : [],
    };
  } catch {
    return emptyLifetime(Date.now());
  }
}

export function writeLifetime(path: string, state: LifetimeState): void {
  const trimmed: LifetimeState = {
    ...state,
    sessionIds: state.sessionIds.slice(-MAX_SESSIONS),
    latencies: state.latencies.slice(-MAX_LATENCIES),
  };
  const temporary = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(trimmed)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // Statistics are best-effort: failing to persist must never affect routing.
    try {
      rmSync(temporary, { force: true });
    } catch {
      // nothing further to do
    }
  }
}

/**
 * One JSON line per decision call. Records the model, stage, timing and outcome, and never the
 * prompt text or any skill description, so the log is safe to leave on.
 */
export function appendDebugLog(path: string, entry: CallLogEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ...entry, at: new Date(entry.at).toISOString() })}\n`);
  } catch {
    // A debug log that cannot be written is not worth surfacing.
  }
}

export interface StatusInput {
  session: Tally;
  lifetime: LifetimeState;
  last: RoundRecord | null;
  /** Model the last round used. */
  lastModel: string | null;
  /** Roster size the last round saw. */
  lastRosterSize: number | null;
  /** Set when the extension could not resolve a model for the last round. */
  modelError: string | null;
  /** Why the most recent turn was skipped, when it was. */
  lastSkip: SkipReason | null;
  /** Config sources, so the report says where the policy came from. */
  configSources: string[];
  configError: string | null;
}

function tokens(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}k`;
}

/**
 * Cost is shown only when the model has a catalog price. Six of the twenty-six shipped classifier
 * models have none — including `typesafe/jev-latest`, the first default preference — and Pi reports
 * those as $0 however many tokens they consume, so a dollar figure would be a lie.
 */
function spend(tally: Tally): string {
  if (tally.rounds === 0) return "0";
  if (tally.anyUnpriced) return `${tokens(tally.inputTokens)} · cost n/a`;
  return `${tokens(tally.inputTokens)} · $${tally.costUsd.toFixed(4)}`;
}

function rate(part: number, whole: number): string {
  if (whole === 0) return "0";
  return `${Math.round((part / whole) * 100)}% (${part}/${whole})`;
}

function clock(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function day(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function truncate(text: string, limit: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`;
}

function row(label: string, sessionValue: string, lifetimeValue: string): string {
  return `  ${label.padEnd(11)} ${sessionValue.padEnd(22)}${lifetimeValue}`;
}

/**
 * The status report: session and lifetime side by side, then the most recent round in full.
 * Session figures come from memory; lifetime figures come from the counter file.
 */
export function renderStatus(input: StatusInput): string {
  const { session, lifetime, last } = input;
  const lines: string[] = [];

  lines.push(`auto-suggest-skill   ${session.rounds} session / ${lifetime.rounds} lifetime`);

  if (input.modelError) lines.push(`  model       ${input.modelError}`);
  if (input.configError) lines.push(`  config      ${input.configError}`);
  if (input.configSources.length > 0) {
    for (const source of input.configSources) lines.push(`  config      ${source}`);
  }

  lines.push("");
  lines.push(row("metric", "session", "lifetime"));
  lines.push(row("rounds", String(session.rounds), String(lifetime.rounds)));
  lines.push(row("api calls", String(session.apiCalls), String(lifetime.apiCalls)));
  lines.push(row("suggested", rate(session.suggested, session.rounds), rate(lifetime.suggested, lifetime.rounds)));
  lines.push(row("none", rate(session.none, session.rounds), rate(lifetime.none, lifetime.rounds)));
  lines.push(row("failed", rate(session.failed, session.rounds), rate(lifetime.failed, lifetime.rounds)));
  lines.push(row("skipped", String(session.skipped), String(lifetime.skipped)));
  lines.push(row("tokens", spend(session), spend(lifetime)));
  lines.push(
    row("latency", `p50 ${percentile(session.latencies, 0.5)}ms`, `p50 ${percentile(lifetime.latencies, 0.5)}ms`),
  );
  if (lifetime.sessionIds.length > 0) {
    const plural = lifetime.sessionIds.length === 1 ? "" : "s";
    lines.push(row("since", "", `${day(lifetime.firstSeenAt)} (${lifetime.sessionIds.length} session${plural})`));
  }

  lines.push("");
  if (!last) {
    lines.push("  last round (none yet this session)");
    if (input.lastSkip) lines.push(`  skipped    ${input.lastSkip}`);
    return lines.join("\n");
  }

  const roster = input.lastRosterSize === null ? "" : ` of ${input.lastRosterSize}`;
  lines.push(
    `  last round ${clock(last.at)} · ${input.lastModel ?? "unknown model"} · ${last.apiCalls} call${
      last.apiCalls === 1 ? "" : "s"
    }${roster === "" ? "" : ` · roster${roster}`}`,
  );
  if (last.gate !== undefined) lines.push(`  gate       ${last.gate.toFixed(2)}`);
  if (last.shortlist && last.shortlist.length > 0) {
    lines.push(`  shortlist  [${last.shortlist.join(", ")}]`);
  }
  if (last.outcome === "suggested") {
    const fits = last.winnerFits === undefined ? "" : ` ${last.winnerFits.toFixed(2)}`;
    lines.push(`  result     suggested ${last.winner ?? "?"}${fits} · ${last.latencyMs}ms`);
  } else if (last.outcome === "none") {
    lines.push(`  result     no suggestion · ${last.reason ?? "no reason recorded"} · ${last.latencyMs}ms`);
  } else {
    lines.push(
      `  result     failed ${last.errorCode ?? "error"} · ${truncate(last.reason ?? "", 60)} · ${last.latencyMs}ms`,
    );
  }

  return lines.join("\n");
}

/** The outcome label for a finished round. */
export function outcomeFor(suggestion: Suggestion): Outcome {
  return suggestion.skill ? "suggested" : "none";
}
