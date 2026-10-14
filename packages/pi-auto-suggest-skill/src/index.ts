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
 *   - The roster is removed on every turn the extension is enabled for, ahead of every gate. Pi
 *     rebuilds `systemPromptOptions` from its own base on each run and discards this event's copy,
 *     so the removal is not sticky and has to be repeated every turn.
 *   - A failure to decide is not a failure of the turn: the roster stays removed and no
 *     recommendation arrives, which is what A does and what the guidance paragraph describes.
 *   - The only switch that leaves Pi's prompt as Pi built it is `enabled: false`.
 *
 * Derived from `iamdin/pi-jev-skill-suggestion` (MIT): the strip, the two-stage router, the
 * context dedup and the thresholds are A's. The on-demand tool and the trigger configuration are
 * removed; the model preference, the config file, the statistics and the status command are new.
 */
import type { ClassifierApi, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Skill,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
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
  emptyPending,
  emptyTally,
  mergeLifetime,
  outcomeFor,
  readLifetime,
  renderStatus,
  renderStatusStyled,
  writeLifetime,
  type LifetimeState,
  type Painter,
  type PendingLifetime,
  type RoundRecord,
  type StatusColor,
  type StatusInput,
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

/** The part of `before_agent_start`'s event this extension reads and writes. */
interface SystemPromptEvent {
  systemPromptOptions: { skills: Skill[]; sections: Record<string, string> };
}

interface SessionState {
  config: AutoSuggestConfig;
  configSources: string[];
  configError: string | null;
  session: Tally;
  /** The lifetime tally as the counter file last had it, so the status report can show it. */
  lifetime: LifetimeState;
  /** This session's contributions since the last write, folded into the file on every write. */
  pending: PendingLifetime;
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
      pending: emptyPending(),
      last: null,
      lastModel: null,
      lastRosterSize: null,
      modelError: null,
      lastSkip: null,
      counterFile,
    };
    return state;
  }

  /**
   * Persist this session's unsaved contributions, merged into the counter file as it is on disk
   * right now rather than written out from the snapshot loaded at session start. Several Pi
   * processes share the file, so a snapshot write silently drops every round another session
   * recorded in between.
   */
  function flush(current: SessionState): void {
    const { tally, sessionIds } = current.pending;
    if (tally.rounds === 0 && tally.skipped === 0 && sessionIds.length === 0) return;
    const merged = mergeLifetime(readLifetime(current.counterFile), current.pending);
    writeLifetime(current.counterFile, merged);
    current.lifetime = merged;
    current.pending = emptyPending();
  }

  /** Apply a round to both tallies and persist. Writes after every round so a crash loses nothing. */
  function commitRound(current: SessionState, record: RoundRecord): void {
    applyRound(current.session, record);
    applyRound(current.pending.tally, record);
    current.last = record;
    flush(current);
  }

  function skip(current: SessionState, reason: SkipReason): void {
    applySkip(current.session);
    applySkip(current.pending.tally);
    current.lastSkip = reason;
    flush(current);
  }

  /**
   * Remove the roster and describe the new contract. Called on every turn the extension is enabled
   * for, ahead of every gate, so the roster never costs context even on a turn that decides nothing.
   *
   * Idempotent, which is what makes the repetition safe: this event's options copy is the only place
   * either value can be set, and Pi rebuilds it from its own base on each run.
   */
  function strip(event: SystemPromptEvent): void {
    event.systemPromptOptions.skills = [];
    event.systemPromptOptions.sections[GUIDANCE_SECTION] = GUIDANCE;
  }

  pi.on("session_start", async (_event, ctx) => {
    state = null;
    const current = ensureState(ctx);
    const sessionId = ctx.sessionManager.getSessionId();
    if (!current.pending.sessionIds.includes(sessionId)) current.pending.sessionIds.push(sessionId);
    flush(current);

    if (current.configError) {
      ctx.ui.notify(`auto-suggest-skill: ${current.configError}`, "error");
    }
    if (!current.config.enabled) {
      ctx.ui.notify("auto-suggest-skill: disabled in config; Pi's skill list is untouched", "info");
    }
  });

  pi.on("session_shutdown", () => {
    if (state) flush(state);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const current = ensureState(ctx);
    current.lastSkip = null;

    // The one switch that leaves Pi's prompt as Pi built it.
    if (!current.config.enabled) {
      skip(current, "disabled");
      return undefined;
    }

    // Read the roster before stripping it. The strip below empties this event, and every gate past it
    // still needs the names.
    const roster = toRoster(event.systemPromptOptions.skills);
    const task = event.prompt;
    const excluded = new Set(current.config.neverSuggest);
    const candidates = roster.filter((skill) => !excluded.has(skill.name));

    // Strip ahead of every gate rather than behind them. Pi hands this handler a copy of
    // `systemPromptOptions` freshly normalized from the session's base options on every run, so the
    // removal would not stick: leaving it to the routing paths would hand the roster back on every
    // turn that skips a decision. No hook earlier than this one carries the prompt options, so this
    // is the earliest the roster can go, and the session's first request is built after it.
    strip(event);

    if (!skillReader(pi.getActiveTools())) {
      skip(current, "no-reader");
      return undefined;
    }

    // Pi expands `/skill:name` before this hook, so the prompt is a skill envelope, not a task.
    if (
      isSkillExpansion(task) ||
      trivialTurn(
        task,
        candidates.map((skill) => skill.name),
      )
    ) {
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
      const input = statusInput(ensureState(ctx));
      // A custom component needs a real terminal; every other mode renders the plain report.
      if (ctx.mode === "tui") {
        await showStatusReport(ctx, input);
        return;
      }
      ctx.ui.notify(renderStatus(input), "info");
    },
  });
}

/** Theme tokens for the report's semantic colors. */
const STATUS_COLOR: Record<StatusColor, ThemeColor> = {
  title: "accent",
  label: "muted",
  value: "text",
  quiet: "dim",
  good: "success",
  bad: "error",
  warn: "warning",
};

/** The colorizer the report's styled rendering takes. */
function statusPainter(theme: Theme): Painter {
  return (color, text) => {
    const styled = theme.fg(STATUS_COLOR[color], text);
    return color === "title" ? theme.bold(styled) : styled;
  };
}

/**
 * The report as a focused panel.
 *
 * `notify()` renders its whole message in one dim color, which flattens a table whose point is that a
 * failed round, an idle session and a healthy one read differently at a glance. A custom component
 * owns its styling, and a report this long wants a panel rather than a line of transcript.
 */
async function showStatusReport(ctx: ExtensionCommandContext, input: StatusInput): Promise<void> {
  await ctx.ui.custom((_tui, theme, _keybindings, done) => {
    const border = new DynamicBorder((text: string) => theme.fg("border", text));
    const report = renderStatusStyled(input, statusPainter(theme)).join("\n");
    const container = new Container();
    container.addChild(border);
    container.addChild(new Text(report, 1, 1));
    container.addChild(new Text(theme.fg("dim", "Enter or Esc to close"), 1, 0));
    container.addChild(border);
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
      },
    };
  });
}

/** The report input, assembled from the session state. */
function statusInput(current: SessionState): StatusInput {
  return {
    session: current.session,
    lifetime: current.lifetime,
    last: current.last,
    lastModel: current.lastModel,
    lastRosterSize: current.lastRosterSize,
    modelError: current.modelError,
    lastSkip: current.lastSkip,
    configSources: current.configSources,
    configError: current.configError,
  };
}

function messageFor(suggestion: Suggestion) {
  const content = formatSuggestion(suggestion);
  if (!content) return undefined;
  return { customType: SUGGESTION_TYPE, content, display: true, details: suggestion };
}
