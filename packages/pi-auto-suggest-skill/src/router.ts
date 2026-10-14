/**
 * The two-stage skill router, adapted from `iamdin/pi-jev-skill-suggestion` (MIT).
 *
 * Stage 1 is one `choice` question per chunk of the roster, with the three gate questions riding in
 * the first chunk so the gate costs no extra call. Stage 2 re-asks over the shortlist with each
 * candidate's `SKILL.md` excerpt in front of it, plus a per-candidate `bool` fit question, and the
 * winner must clear a fit floor.
 *
 * Thresholds 0.30 (gate) and 0.40 (fits) are A's, adapted from hermes-jev-skills where they were
 * measured. The question wording is likewise A's, and is deliberately not paraphrased: it was
 * measured upstream, and this extension has no measurement of its own to justify changing it.
 * The one addition is `criteria` on the `bool` questions, which Pi's classifier contract requires
 * and the TypeSafe SDK did not; each restates the question's own polarity.
 */
import { readFile } from "node:fs/promises";
import {
  EXCERPT_CHARS,
  FITS_THRESHOLD,
  MAX_CHOICES,
  NONE_THRESHOLD,
  SHORTLIST_SIZE,
  STAGE1_CONCURRENCY,
} from "./config.js";
import type {
  BoolAnswer,
  ChoiceAnswer,
  ClassifierResult,
  DecisionClient,
  DecisionRequest,
  RosterSkill,
  Suggestion,
} from "./types.js";

const CHUNK_CHOICES = MAX_CHOICES - 1; // room for none_of_these when chunked
const NONE_OPTION = "none_of_these";

const CHOICE_INSTRUCTIONS =
  "Which of these skills, if any, is the right one to load to help with the user's latest request?";

/**
 * A's three gate questions. `prose_suffices` is inverted: a high answer means no skill is needed.
 * Each `criteria` restates the question's polarity, since Pi's `bool` question requires them.
 */
const GATE_QUESTIONS: Record<
  string,
  { instructions: string; criteria: { true: string; false: string } }
> = {
  acts_on_user_system: {
    instructions:
      "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
    criteria: {
      true: "The request asks the assistant to act on the user's files, accounts, devices, or online services",
      false: "The request only asks for explanation or advice",
    },
  },
  would_follow_documented_procedure: {
    instructions:
      "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
    criteria: {
      true: "A careful expert would consult a specific documented procedure or set of commands",
      false: "General understanding is enough",
    },
  },
  prose_suffices: {
    instructions:
      "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
    criteria: {
      true: "A knowledgeable generalist could fully satisfy this in prose, with no tools, no documentation, and no file or account access",
      false: "Tools, documentation, or access to the user's files or accounts would be needed",
    },
  },
};

/** `prose_suffices` is the one question whose polarity is reversed. */
const INVERTED = new Set(["prose_suffices"]);

const RERANK_INSTRUCTIONS =
  "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.";

/** A decision call that did not return `stopReason: "stop"`, with a coarse code for the report. */
export class RouterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RouterError";
    this.code = code;
  }
}

/**
 * Turn a non-`stop` result into a code. `classify()` never rejects, so a provider failure arrives
 * as a result with a safe `errorMessage`; the mapping keeps the status report readable without
 * exposing provider text.
 */
export function errorCodeFor(result: ClassifierResult): string {
  if (result.stopReason === "aborted") return "aborted";
  const message = result.errorMessage ?? "";
  if (/401|403|unauthor|api[ _-]?key|authentication/iu.test(message)) return "auth";
  if (/429|rate[ _-]?limit/iu.test(message)) return "rate_limit";
  if (/timed? ?out|timeout/iu.test(message)) return "timeout";
  return "error";
}

function unwrap(result: ClassifierResult): ClassifierResult {
  if (result.stopReason !== "stop") {
    throw new RouterError(errorCodeFor(result), result.errorMessage ?? "decision call failed");
  }
  return result;
}

/** A round that produced no skill, carrying enough detail to explain why. */
export function none(
  reason: string,
  extras: Partial<Pick<Suggestion, "gate" | "shortlist" | "fits">> = {},
): Suggestion {
  return { skill: null, location: null, reason, gate: 0, shortlist: [], fits: {}, ...extras };
}

export function chunkRoster<T>(items: readonly T[], size: number): T[][] {
  if (size > MAX_CHOICES) throw new Error(`chunk size ${size} exceeds the API cap ${MAX_CHOICES}`);
  if (items.length === 0) return [[]];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    chunks.push(items.slice(index, index + size));
  return chunks;
}

function boolValue(answers: Record<string, { type: string }>, key: string): number {
  const answer = answers[key] as BoolAnswer | undefined;
  return answer?.type === "bool" ? answer.probability : 0;
}

async function skillExcerpt(skill: RosterSkill, chars: number): Promise<string> {
  try {
    const raw = await readFile(skill.filePath, "utf8");
    return raw
      .replace(/^---[\s\S]*?---\s*/, "")
      .trim()
      .slice(0, chars);
  } catch {
    return "";
  }
}

/**
 * Build a shortlist from chunked Choice ranks.
 *
 * Cross-chunk probabilities are not comparable, because each chunk renormalizes to 1, so each
 * surviving chunk's winner is taken first and the rest are filled from the strongest chunk. Stage 2
 * does the real cross-candidate comparison.
 */
export function pickShortlist(
  perChunk: ReadonlyArray<ReadonlyArray<readonly [string, number]>>,
  nonePressure: readonly number[],
  shortlistSize: number,
): string[] {
  if (perChunk.length === 0 || shortlistSize <= 0) return [];

  const bestChunk = perChunk.reduce(
    (best, ranked, index) =>
      (ranked[0]?.[1] ?? -1) > (perChunk[best]?.[0]?.[1] ?? -1) ? index : best,
    0,
  );

  const surviving: number[] = [];
  for (let index = 0; index < perChunk.length; index++) {
    if (index === bestChunk || (nonePressure[index] ?? 0) < NONE_THRESHOLD) surviving.push(index);
  }
  surviving.sort((a, b) => {
    if (a === bestChunk) return -1;
    if (b === bestChunk) return 1;
    return (nonePressure[a] ?? 0) - (nonePressure[b] ?? 0) || a - b;
  });

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (name: string | undefined): boolean => {
    if (!name || seen.has(name)) return out.length >= shortlistSize;
    out.push(name);
    seen.add(name);
    return out.length >= shortlistSize;
  };

  // One winner per surviving chunk gets a fair seat in the tournament.
  for (const index of surviving) {
    if (push(perChunk[index]?.[0]?.[0])) return out;
  }
  // Same-chunk ranks are comparable, so fill from the strongest chunk first.
  for (const [name] of perChunk[bestChunk] ?? []) {
    if (push(name)) return out;
  }
  for (const index of surviving) {
    if (index === bestChunk) continue;
    for (const [name] of perChunk[index] ?? []) {
      if (push(name)) return out;
    }
  }
  return out;
}

export interface RankWideResult {
  gate: number;
  shortlist: string[];
}

/** Stage 1: gate plus a chunked wide ranking. */
export async function rankWide(
  client: DecisionClient,
  task: string,
  roster: readonly RosterSkill[],
  shortlistSize: number,
  signal?: AbortSignal,
): Promise<RankWideResult> {
  const groups = chunkRoster(roster, CHUNK_CHOICES);
  const chunked = groups.length > 1;
  const state = { request: task };

  const calls = groups.map((group, index) => {
    const criteria: Record<string, string> = {};
    for (const skill of group) criteria[skill.name] = skill.description;
    if (chunked) criteria[NONE_OPTION] = "None of these skills fit the request.";

    const questions: DecisionRequest["questions"] = {
      which: { type: "choice", instructions: CHOICE_INSTRUCTIONS, criteria },
    };
    if (index === 0) {
      for (const [key, question] of Object.entries(GATE_QUESTIONS)) {
        questions[`gate::${key}`] = { type: "bool", ...question };
      }
    }
    return { state, questions };
  });

  const responses = await mapWithLimit(calls, STAGE1_CONCURRENCY, (request) =>
    client.decide(request, { signal, stage: "rank" }).then(unwrap),
  );

  const perChunk: Array<Array<[string, number]>> = [];
  const nonePressure: number[] = [];
  for (const response of responses) {
    const which = response.answers.which as ChoiceAnswer | undefined;
    const probabilities = which?.type === "choice" ? which.probabilities : {};
    const ranked = Object.entries(probabilities)
      .filter(([name]) => name !== NONE_OPTION)
      .map(([name, probability]) => [name, Number(probability)] as [string, number])
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    perChunk.push(ranked);
    nonePressure.push(Number(probabilities[NONE_OPTION] ?? 0));
  }

  const first = responses[0]!;
  const oriented: number[] = [];
  for (const key of Object.keys(GATE_QUESTIONS)) {
    const value = boolValue(first.answers, `gate::${key}`);
    oriented.push(INVERTED.has(key) ? 1 - value : value);
  }
  const gate = oriented.length ? oriented.reduce((a, b) => a + b, 0) / oriented.length : 0;

  return { gate, shortlist: pickShortlist(perChunk, nonePressure, shortlistSize) };
}

export interface RerankResult {
  winner: string | null;
  fits: Record<string, number>;
}

/** Stage 2: one choice over the shortlist, with excerpts, plus per-candidate fit questions. */
export async function rerank(
  client: DecisionClient,
  task: string,
  names: readonly string[],
  byName: ReadonlyMap<string, RosterSkill>,
  signal?: AbortSignal,
): Promise<RerankResult> {
  const criteria: Record<string, string> = {
    [NONE_OPTION]: "None of these skills fit the request.",
  };
  const excerpts = await Promise.all(
    names.map((name) => skillExcerpt(byName.get(name)!, EXCERPT_CHARS)),
  );
  for (let index = 0; index < names.length; index++) {
    const name = names[index]!;
    const skill = byName.get(name)!;
    const excerpt = excerpts[index]!;
    criteria[name] = excerpt ? `${skill.description}\n\nSKILL.md: ${excerpt}` : skill.description;
  }

  const questions: DecisionRequest["questions"] = {
    which: { type: "choice", instructions: RERANK_INSTRUCTIONS, criteria },
  };
  for (const name of names) {
    const skill = byName.get(name)!;
    questions[`fits::${name}`] = {
      type: "bool",
      instructions: `Does the skill '${name}' do the specific thing the user's request asks for? It is described as: ${skill.description}`,
      criteria: {
        true: "The skill does the specific thing the request asks for",
        false: "The skill does not do the specific thing the request asks for",
      },
    };
  }

  const response = unwrap(
    await client.decide({ state: { request: task }, questions }, { signal, stage: "rerank" }),
  );
  const which = response.answers.which as ChoiceAnswer | undefined;
  const picked = which?.type === "choice" ? which.choice : undefined;
  const fits: Record<string, number> = {};
  for (const name of names) fits[name] = boolValue(response.answers, `fits::${name}`);

  return { winner: !picked || picked === NONE_OPTION ? null : picked, fits };
}

export interface SuggestOptions {
  signal?: AbortSignal;
  shortlistSize?: number;
  /** The gate threshold; below it no skill is wanted. */
  threshold: number;
}

/** Run one routing round. Throws `RouterError` when a decision call fails. */
export async function suggest(
  client: DecisionClient,
  task: string,
  roster: readonly RosterSkill[],
  options: SuggestOptions,
): Promise<Suggestion> {
  if (roster.length === 0) return none("roster empty");

  const shortlistSize = options.shortlistSize ?? SHORTLIST_SIZE;
  const byName = new Map(roster.map((skill) => [skill.name, skill]));
  const wide = await rankWide(client, task, roster, shortlistSize, options.signal);

  if (wide.gate < options.threshold) {
    return none(`gate ${wide.gate.toFixed(2)} < ${options.threshold.toFixed(2)}: no skill wanted`, {
      gate: wide.gate,
    });
  }

  if (wide.shortlist.length === 0) return none("no shortlist", { gate: wide.gate });

  const second = await rerank(client, task, wide.shortlist, byName, options.signal);
  if (!second.winner) {
    return none("stage 2 picked none: no skill fits", {
      gate: wide.gate,
      shortlist: wide.shortlist,
      fits: second.fits,
    });
  }

  const winnerFits = second.fits[second.winner] ?? 0;
  if (winnerFits < FITS_THRESHOLD) {
    return none(
      `winner ${second.winner} fits ${winnerFits.toFixed(2)} < ${FITS_THRESHOLD.toFixed(2)}`,
      {
        gate: wide.gate,
        shortlist: wide.shortlist,
        fits: second.fits,
      },
    );
  }

  const skill = byName.get(second.winner)!;
  return {
    skill: second.winner,
    location: skill.filePath,
    reason: `shortlist winner with fits ${winnerFits.toFixed(2)}`,
    gate: wide.gate,
    shortlist: wide.shortlist,
    fits: second.fits,
  };
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  });
  await Promise.all(runners);
  return results;
}
