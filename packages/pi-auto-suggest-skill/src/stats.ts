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
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/** Fold one tally into another. Used to apply a session's unsaved delta to the file's state. */
export function addTally(target: Tally, delta: Tally): void {
  target.rounds += delta.rounds;
  target.apiCalls += delta.apiCalls;
  target.rankCalls += delta.rankCalls;
  target.rerankCalls += delta.rerankCalls;
  target.suggested += delta.suggested;
  target.none += delta.none;
  target.failed += delta.failed;
  target.skipped += delta.skipped;
  target.inputTokens += delta.inputTokens;
  target.costUsd += delta.costUsd;
  target.anyUnpriced ||= delta.anyUnpriced;
  target.latencies.push(...delta.latencies);
  if (target.latencies.length > MAX_LATENCIES) {
    target.latencies.splice(0, target.latencies.length - MAX_LATENCIES);
  }
}

/** What one session has to contribute to the counter file since the file was last written. */
export interface PendingLifetime {
  tally: Tally;
  sessionIds: string[];
}

export function emptyPending(): PendingLifetime {
  return { tally: emptyTally(), sessionIds: [] };
}

/**
 * Fold a session's unsaved contributions into the lifetime state as it is on disk right now.
 *
 * The counter file is shared by every Pi process on the machine, so a session must never write out
 * the snapshot it loaded at session start: that would drop every round another session recorded in
 * the meantime. It writes only what it has added since its own last write.
 */
export function mergeLifetime(disk: LifetimeState, pending: PendingLifetime): LifetimeState {
  const merged: LifetimeState = {
    ...disk,
    latencies: [...disk.latencies],
    sessionIds: [...disk.sessionIds],
  };
  addTally(merged, pending.tally);
  for (const id of pending.sessionIds) {
    if (!merged.sessionIds.includes(id)) merged.sessionIds.push(id);
  }
  return merged;
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
    const base = emptyLifetime(
      typeof parsed.firstSeenAt === "number" ? parsed.firstSeenAt : Date.now(),
    );
    return {
      ...base,
      ...parsed,
      version: 1,
      latencies: Array.isArray(parsed.latencies)
        ? parsed.latencies.filter((n) => typeof n === "number")
        : [],
      sessionIds: Array.isArray(parsed.sessionIds)
        ? parsed.sessionIds.filter((s) => typeof s === "string")
        : [],
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

/**
 * The semantic colors the report uses. The caller maps these onto theme tokens, so this module needs
 * no theme import and `renderStatus` stays a pure string function.
 */
export type StatusColor = "title" | "label" | "value" | "quiet" | "good" | "bad" | "warn";

/** Colorizes one span of the report. */
export type Painter = (color: StatusColor, text: string) => string;

/** The painter that produces the plain text `renderStatus` returns. */
export const PLAIN: Painter = (_color, text) => text;

/** The label column, then one separator space, so every value starts in the same column. */
const LABEL_WIDTH = 11;
/** Width of the session column, so the lifetime column starts at a fixed offset. */
const SESSION_WIDTH = 22;

/** One field of the report: its text, and the color it renders in. */
interface Cell {
  text: string;
  color: StatusColor;
}

function cell(text: string, color: StatusColor = "value"): Cell {
  return { text, color };
}

/** A row with one value column: a label, then the value as one or more colored spans. */
function detail(paint: Painter, label: string, parts: readonly Cell[]): string {
  const value = parts.map((part) => paint(part.color, part.text)).join("");
  return `  ${paint("label", label.padEnd(LABEL_WIDTH))} ${value}`;
}

/**
 * A row of the session/lifetime table. The session column is padded before any color is applied,
 * because an escape sequence applied first would count as a column and shear the table.
 */
function row(
  paint: Painter,
  label: string,
  session: readonly Cell[],
  lifetime: readonly Cell[],
): string {
  const used = session.reduce((width, part) => width + part.text.length, 0);
  const gap = Math.max(0, SESSION_WIDTH - used);
  const padding = gap > 0 ? [cell(" ".repeat(gap), "quiet")] : [];
  return detail(paint, label, [...session, ...padding, ...lifetime]);
}

function tokens(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}k`;
}

/**
 * Cost is shown only when the model has a catalog price. Six of the twenty-six shipped classifier
 * models have none — including `typesafe/jev-latest`, the first default preference — and Pi reports
 * those as $0 however many tokens they consume, so a dollar figure would be a lie. The `cost n/a`
 * clause is a warning rather than a value, because the figure beside it is not what it looks like.
 */
function spend(tally: Tally): Cell[] {
  if (tally.rounds === 0) return [cell("0")];
  if (tally.anyUnpriced) return [cell(tokens(tally.inputTokens)), cell(" · cost n/a", "warn")];
  return [cell(`${tokens(tally.inputTokens)} · $${tally.costUsd.toFixed(4)}`)];
}

function rate(part: number, whole: number): string {
  if (whole === 0) return "0";
  return `${Math.round((part / whole) * 100)}% (${part}/${whole})`;
}

/** A rate that is only worth noticing when it is not zero. */
function outcomeRate(part: number, whole: number, color: StatusColor): Cell {
  return cell(rate(part, whole), part > 0 ? color : "quiet");
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

/**
 * The status report: session and lifetime side by side, then the most recent round in full.
 * Session figures come from memory; lifetime figures come from the counter file.
 *
 * One layout, painted by the caller. `renderStatus` and the TUI panel are the same lines, so the two
 * renderings cannot drift apart.
 */
function statusLines(input: StatusInput, paint: Painter): string[] {
  return [...tableLines(input, paint), "", ...roundLines(input, paint)];
}

/** The title, any config or model error, and the session/lifetime table. */
function tableLines(input: StatusInput, paint: Painter): string[] {
  const { session, lifetime } = input;
  return [
    titleLine(input, paint),
    ...problemLines(input, paint),
    "",
    row(paint, "metric", [cell("session", "quiet")], [cell("lifetime", "quiet")]),
    row(paint, "rounds", [cell(String(session.rounds))], [cell(String(lifetime.rounds))]),
    row(paint, "api calls", [cell(String(session.apiCalls))], [cell(String(lifetime.apiCalls))]),
    row(
      paint,
      "suggested",
      [outcomeRate(session.suggested, session.rounds, "good")],
      [outcomeRate(lifetime.suggested, lifetime.rounds, "good")],
    ),
    row(
      paint,
      "none",
      [cell(rate(session.none, session.rounds))],
      [cell(rate(lifetime.none, lifetime.rounds))],
    ),
    row(
      paint,
      "failed",
      [outcomeRate(session.failed, session.rounds, "bad")],
      [outcomeRate(lifetime.failed, lifetime.rounds, "bad")],
    ),
    row(paint, "skipped", [cell(String(session.skipped))], [cell(String(lifetime.skipped))]),
    row(paint, "tokens", spend(session), spend(lifetime)),
    row(
      paint,
      "latency",
      [cell(`p50 ${percentile(session.latencies, 0.5)}ms`)],
      [cell(`p50 ${percentile(lifetime.latencies, 0.5)}ms`)],
    ),
    ...sinceLines(input, paint),
  ];
}

/** The heading: what this is, and how many rounds the session and the machine have seen. */
function titleLine(input: StatusInput, paint: Painter): string {
  return (
    `${paint("title", "auto-suggest-skill")}   ` +
    `${paint("value", String(input.session.rounds))}${paint("quiet", " session / ")}` +
    `${paint("value", String(input.lifetime.rounds))}${paint("quiet", " lifetime")}`
  );
}

/** A model that would not resolve, a config that would not load, and where the config came from. */
function problemLines(input: StatusInput, paint: Painter): string[] {
  const lines: string[] = [];
  if (input.modelError) lines.push(detail(paint, "model", [cell(input.modelError, "bad")]));
  if (input.configError) lines.push(detail(paint, "config", [cell(input.configError, "bad")]));
  for (const source of input.configSources) {
    lines.push(detail(paint, "config", [cell(source, "quiet")]));
  }
  return lines;
}

/** How far back the lifetime tally reaches, when it has seen at least one session. */
function sinceLines(input: StatusInput, paint: Painter): string[] {
  const { sessionIds, firstSeenAt } = input.lifetime;
  if (sessionIds.length === 0) return [];
  const plural = sessionIds.length === 1 ? "" : "s";
  const seen = `${day(firstSeenAt)} (${sessionIds.length} session${plural})`;
  return [row(paint, "since", [], [cell(seen, "quiet")])];
}

/** The most recent round in full: which model decided, on what evidence, and how it went. */
function roundLines(input: StatusInput, paint: Painter): string[] {
  const { last } = input;
  if (!last) {
    const lines = [detail(paint, "last round", [cell("(none yet this session)", "quiet")])];
    if (input.lastSkip) lines.push(detail(paint, "skipped", [cell(input.lastSkip, "quiet")]));
    return lines;
  }

  const lines = [
    detail(paint, "last round", [
      cell(clock(last.at)),
      cell(" · ", "quiet"),
      cell(input.lastModel ?? "unknown model", "title"),
      cell(` · ${last.apiCalls} call${last.apiCalls === 1 ? "" : "s"}`, "quiet"),
      ...(input.lastRosterSize === null
        ? []
        : [cell(` · roster of ${input.lastRosterSize}`, "quiet")]),
    ]),
  ];
  if (last.gate !== undefined) lines.push(detail(paint, "gate", [cell(last.gate.toFixed(2))]));
  if (last.shortlist && last.shortlist.length > 0) {
    lines.push(detail(paint, "shortlist", [cell(`[${last.shortlist.join(", ")}]`, "quiet")]));
  }
  lines.push(detail(paint, "result", resultCells(last)));
  return lines;
}

/** What the round concluded: a suggestion is good, a failure is bad, and no suggestion is neither. */
function resultCells(last: RoundRecord): Cell[] {
  const latency = cell(` · ${last.latencyMs}ms`, "quiet");
  if (last.outcome === "suggested") {
    const fits = last.winnerFits === undefined ? "" : ` ${last.winnerFits.toFixed(2)}`;
    return [cell(`suggested ${last.winner ?? "?"}${fits}`, "good"), latency];
  }
  if (last.outcome === "none") {
    return [cell(`no suggestion · ${last.reason ?? "no reason recorded"}`, "quiet"), latency];
  }
  const reason = truncate(last.reason ?? "", 60);
  return [cell(`failed ${last.errorCode ?? "error"} · ${reason}`, "bad"), latency];
}

/**
 * The report as plain text, for `notify()` and for any mode that cannot style a component.
 */
export function renderStatus(input: StatusInput): string {
  return statusLines(input, PLAIN).join("\n");
}

/**
 * The report as one styled line per entry, for a component that owns its own rendering. The painter
 * maps the report's semantic colors onto the active theme's tokens.
 */
export function renderStatusStyled(input: StatusInput, paint: Painter): string[] {
  return statusLines(input, paint);
}

/** The outcome label for a finished round. */
export function outcomeFor(suggestion: Suggestion): Outcome {
  return suggestion.skill ? "suggested" : "none";
}
