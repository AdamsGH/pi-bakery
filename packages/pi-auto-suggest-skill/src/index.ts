/**
 * pi-auto-suggest-skill
 *
 * Pi renders every installed skill's name and description into the system prompt. With a large
 * roster that is a lot of context spent on skills the turn will not use. This extension removes
 * that block and asks a small classifier model which skill, if any, this turn needs — then injects
 * at most one recommendation.
 *
 * Shape:
 *   - Routing is always on. There is no on-demand tool: the model cannot ask.
 *   - The roster is removed exactly when a routing round happens. Every path that does not decide
 *     anything — no reader, a trivial prompt, no model, a disabled switch — leaves Pi's prompt
 *     untouched, so the model keeps its own listing whenever this extension has nothing to say.
 *   - A failure to decide is not a failure of the turn: the roster stays removed and no
 *     recommendation arrives, which is what A does and what the guidance paragraph describes.
 *
 * Derived from `iamdin/pi-jev-skill-suggestion` (MIT): the strip, the two-stage router, the
 * context dedup and the thresholds are A's. The on-demand tool and the trigger configuration are
 * removed; the model preference, the config file, the statistics and the status command are new.
 */
import type { ClassifierApi, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { loadConfig, type AutoSuggestConfig } from "./config.js";
import { skillsInContext } from "./history.js";
import { isResolvedModel, resolveModel } from "./model.js";
import {
  formatSuggestion,
  GUIDANCE,
  GUIDANCE_SECTION,
  isSkillExpansion,
  SUGGESTION_TYPE,
  trivialTurn,
} from "./prompt.js";
import { RouterError, suggest } from "./router.js";
import {
  appendDebugLog,
  applyRound,
  applySkip,
  counterPath,
  emptyTally,
  outcomeFor,
  readLifetime,
  renderStatus,
  writeLifetime,
  type LifetimeState,
  type RoundRecord,
  type Tally,
} from "./stats.js";
import type { DecisionClient, RosterSkill, SkipReason, Suggestion } from "./types.js";

/** Which tool can load a skill file. Pi omits the skills section entirely when there is none. */
export function skillReader(activeTools: readonly string[]): "read" | "bash" | undefined {
  if (activeTools.includes("read")) return "read";
  if (activeTools.includes("bash")) return "bash";
  return undefined;
}

/** The roster the model is allowed to be told about, in Pi's own order. */
export function toRoster(skills: readonly Skill[] | undefined): RosterSkill[] {
  return (skills ?? [])
    .filter((skill) => !skill.disableModelInvocation)
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
    }));
}

interface SessionState {
  config: AutoSuggestConfig;
  configSources: string[];
  configError: string | null;
  session: Tally;
  lifetime: LifetimeState;
  last: RoundRecord | null;
  lastModel: string | null;
  lastRosterSize: number | null;
  modelError: string | null;
  lastSkip: SkipReason | null;
  counterFile: string;
}

export default function (pi: ExtensionAPI) {
  let state: SessionState | null = null;

  function ensureState(ctx: ExtensionContext): SessionState {
    if (state) return state;
    const loaded = loadConfig({ cwd: ctx.cwd, trusted: ctx.isProjectTrusted() });
    const counterFile = counterPath();
    state = {
      config: loaded.config,
      configSources: loaded.sources.map((source) => `${source.path} (${source.keys.join(", ")})`),
      configError: loaded.error ?? null,
      session: emptyTally(),
      lifetime: readLifetime(counterFile),
      last: null,
      lastModel: null,
      lastRosterSize: null,
      modelError: null,
      lastSkip: null,
      counterFile,
    };
    return state;
  }

  /** Apply a round to both tallies and persist. Writes after every round so a crash loses nothing. */
  function commitRound(current: SessionState, record: RoundRecord): void {
    applyRound(current.session, record);
    applyRound(current.lifetime, record);
    current.last = record;
    writeLifetime(current.counterFile, current.lifetime);
  }

  function skip(current: SessionState, reason: SkipReason): void {
    applySkip(current.session);
    applySkip(current.lifetime);
    current.lastSkip = reason;
  }

  /** Remove the roster and describe the new contract. Called only when a round is about to run. */
  function strip(event: {
    systemPromptOptions: { skills: Skill[]; sections: Record<string, string> };
  }): void {
    event.systemPromptOptions.skills = [];
    event.systemPromptOptions.sections[GUIDANCE_SECTION] = GUIDANCE;
  }

  pi.on("session_start", async (_event, ctx) => {
    state = null;
    const current = ensureState(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    if (!current.lifetime.sessionIds.includes(sessionId))
      current.lifetime.sessionIds.push(sessionId);
    writeLifetime(current.counterFile, current.lifetime);

    if (current.configError) {
      ctx.ui.notify(`auto-suggest-skill: ${current.configError}`, "error");
    }
    if (!current.config.enabled) {
      ctx.ui.notify("auto-suggest-skill: disabled in config; Pi's skill list is untouched", "info");
    }
  });

  pi.on("session_shutdown", () => {
    if (state) writeLifetime(state.counterFile, state.lifetime);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const current = ensureState(ctx);
    current.lastSkip = null;

    if (!current.config.enabled) {
      skip(current, "disabled");
      return undefined;
    }

    if (!skillReader(pi.getActiveTools())) {
      skip(current, "no-reader");
      return undefined;
    }

    const roster = toRoster(event.systemPromptOptions.skills);
    const task = event.prompt;

    // Pi expands `/skill:name` before this hook, so the prompt is a skill envelope, not a task.
    if (isSkillExpansion(task) || trivialTurn(task)) {
      skip(current, "trivial");
      return undefined;
    }

    // alwaysSuggest is a deterministic override: it skips the decision call entirely.
    const forcedName = current.config.alwaysSuggest.find((name) =>
      roster.some((s) => s.name === name),
    );
    if (forcedName) {
      const forced = roster.find((skill) => skill.name === forcedName)!;
      const suggestion: Suggestion = {
        skill: forced.name,
        location: forced.filePath,
        reason: "listed in alwaysSuggest",
        gate: 1,
        shortlist: [],
        fits: {},
      };
      strip(event);
      commitRound(current, {
        at: Date.now(),
        outcome: "suggested",
        apiCalls: 0,
        rankCalls: 0,
        rerankCalls: 0,
        inputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        gate: 1,
        shortlist: [],
        winner: forced.name,
        reason: suggestion.reason,
      });
      current.lastRosterSize = roster.length;
      current.lastModel = "(alwaysSuggest)";
      return { message: messageFor(suggestion) };
    }

    const excluded = new Set(current.config.neverSuggest);
    const candidates = roster.filter((skill) => !excluded.has(skill.name));
    if (candidates.length === 0) {
      skip(current, "no-candidates");
      return undefined;
    }

    const resolution = await resolveModel({
      registry: ctx.modelRegistry,
      prefer: current.config.prefer,
      roster: candidates,
      task,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!isResolvedModel(resolution)) {
      current.modelError = resolution.error;
      skip(current, "no-model");
      return undefined;
    }
    current.modelError = null;

    // Every gate above passed, so this turn has a routing decision: remove the roster now.
    strip(event);

    const model: ClassifierModel<ClassifierApi> = resolution.model;
    const modelLabel = `${model.provider}/${model.id}`;
    const started = Date.now();
    let apiCalls = 0;
    let rankCalls = 0;
    let rerankCalls = 0;
    let inputTokens = 0;
    let costSum = 0;
    let anyUnpriced = false;

    const client: DecisionClient = {
      async decide(request, options): Promise<ClassifierResult> {
        const callStarted = Date.now();
        const result = await ctx.modelRegistry.classify(
          model,
          { state: request.state, questions: request.questions },
          options?.signal ? { signal: options.signal } : {},
        );
        const stage = options?.stage ?? "rank";
        const latencyMs = Date.now() - callStarted;
        apiCalls++;
        if (stage === "rank") rankCalls++;
        else rerankCalls++;
        inputTokens += result.usage?.input ?? 0;
        const cost = result.usage?.cost?.total ?? 0;
        if (cost > 0) costSum += cost;
        else anyUnpriced = true;
        if (current.config.debugLog) {
          appendDebugLog(current.config.debugLog, {
            at: callStarted,
            stage,
            model: modelLabel,
            latencyMs,
            inputTokens: result.usage?.input ?? 0,
            stopReason: result.stopReason,
            ...(result.stopReason === "stop" ? {} : { errorCode: RouterError.name }),
          });
        }
        return result;
      },
    };

    let suggestion: Suggestion | null = null;
    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    try {
      suggestion = await suggest(client, task, candidates, {
        threshold: current.config.threshold,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (error) {
      if (error instanceof RouterError) {
        errorCode = error.code;
        errorMessage = error.message;
      } else {
        errorCode = "error";
        errorMessage = error instanceof Error ? error.message : String(error);
      }
    }

    const at = Date.now();
    const latencyMs = at - started;
    const costUsd = anyUnpriced ? null : costSum;
    current.lastRosterSize = candidates.length;
    current.lastModel = modelLabel;

    if (!suggestion) {
      commitRound(current, {
        at,
        outcome: "failed",
        apiCalls,
        rankCalls,
        rerankCalls,
        inputTokens,
        costUsd,
        latencyMs,
        ...(errorCode ? { errorCode } : {}),
        ...(errorMessage ? { reason: errorMessage } : {}),
      });
      return undefined;
    }

    const winnerFits = suggestion.skill ? suggestion.fits[suggestion.skill] : undefined;
    commitRound(current, {
      at,
      outcome: outcomeFor(suggestion),
      apiCalls,
      rankCalls,
      rerankCalls,
      inputTokens,
      costUsd,
      latencyMs,
      gate: suggestion.gate,
      shortlist: suggestion.shortlist,
      ...(suggestion.skill ? { winner: suggestion.skill } : {}),
      ...(winnerFits === undefined ? {} : { winnerFits }),
      reason: suggestion.reason,
    });

    // A skill the model has already read needs no recommendation: it is in context.
    if (suggestion.location) {
      const loaded = skillsInContext(ctx.sessionManager.buildContextEntries(), ctx.cwd);
      if (loaded.has(suggestion.location)) return undefined;
    }

    const message = messageFor(suggestion);
    return message ? { message } : undefined;
  });

  pi.registerCommand("auto-suggest-skill:status", {
    description: "Show auto-suggest-skill decision statistics and the most recent round",
    handler: async (_args, ctx) => {
      const current = ensureState(ctx);
      const text = renderStatus({
        session: current.session,
        lifetime: current.lifetime,
        last: current.last,
        lastModel: current.lastModel,
        lastRosterSize: current.lastRosterSize,
        modelError: current.modelError,
        lastSkip: current.lastSkip,
        configSources: current.configSources,
        configError: current.configError,
      });
      ctx.ui.notify(text, "info");
    },
  });
}

function messageFor(suggestion: Suggestion) {
  const content = formatSuggestion(suggestion);
  if (!content) return undefined;
  return { customType: SUGGESTION_TYPE, content, display: true, details: suggestion };
}
