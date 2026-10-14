import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { ClassifierAnswer, ClassifierResult, DecisionRequest } from "../src/types.js";

/**
 * The extension's own `before_agent_start` handler, driven end to end: a fake `pi`, a fake `ctx`,
 * the event shape Pi hands over, and a fake registry whose `classify` answers the router's
 * questions. The pure-unit tests cannot reach this layer, and this layer is what decides whether
 * Pi's roster is removed and whether a decision call happens at all on a given turn.
 *
 * `getAgentDir` is redirected at a scratch directory so the counter file and the config are never
 * the real ones.
 */
const { AGENT_DIR } = vi.hoisted(() => ({
  AGENT_DIR: `${process.env.TMPDIR ?? "/tmp"}/pi-auto-suggest-skill-handler-test`,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, getAgentDir: () => AGENT_DIR };
});

const extension = (await import("../src/index.js")).default;
const { COUNTER_FILENAME } = await import("../src/stats.js");
const { GUIDANCE, GUIDANCE_SECTION } = await import("../src/prompt.js");

const MODEL: ClassifierModel<ClassifierApi> = {
  type: "classifier",
  id: "jev-latest",
  name: "jev-latest",
  provider: "typesafe",
  api: "typesafe-system-one",
  baseUrl: "https://example.invalid/v1",
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
};

function skill(name: string): Skill {
  return {
    name,
    description: `does ${name}`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { source: "test" },
    disableModelInvocation: false,
  } as Skill;
}

const ROSTER = [skill("commit"), skill("review-code")];

/**
 * Answer every question the router asks. `prose_suffices` is the one inverted gate question, so a
 * `0` there is what says a skill is wanted. Choosing the first real criterion on a `choice`
 * question makes the round end with a suggestion, which is the loudest outcome to assert on.
 */
function answersFor(questions: DecisionRequest["questions"]): ClassifierResult["answers"] {
  const answers: Record<string, ClassifierAnswer> = {};
  for (const [key, question] of Object.entries(questions)) {
    if (question.type === "bool") {
      answers[key] = { type: "bool", probability: key === "gate::prose_suffices" ? 0 : 1 };
      continue;
    }
    const criteria = Object.keys(question.criteria ?? {});
    const choice = criteria.find((name) => name !== "none_of_these") ?? "none_of_these";
    answers[key] = {
      type: "choice",
      choice,
      probabilities: Object.fromEntries(
        criteria.map((name) => [name, name === choice ? 0.9 : 0.1]),
      ),
      confidence: 0.9,
    };
  }
  return answers;
}

interface TurnResult {
  skills: Skill[];
  sections: Record<string, string>;
  result: { message?: { content: string } } | undefined;
}

function harness(
  options: { tools?: string[]; sessionId?: string; models?: ClassifierModel<ClassifierApi>[] } = {},
) {
  const handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
  const commands = new Map<string, (args: string, ctx: never) => Promise<void>>();
  const decided: DecisionRequest[] = [];
  const notifications: string[] = [];

  const ctx = {
    cwd: process.cwd(),
    isProjectTrusted: () => true,
    ui: { notify: (text: string) => notifications.push(text) },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-under-test",
      buildContextEntries: () => [],
    },
    modelRegistry: {
      getAvailableOfType: async () => options.models ?? [MODEL],
      classify: async (_model: unknown, request: DecisionRequest) => {
        decided.push(request);
        return {
          api: "typesafe-system-one",
          provider: "typesafe",
          model: "jev-latest",
          answers: answersFor(request.questions),
          stopReason: "stop",
          timestamp: 0,
        } satisfies ClassifierResult;
      },
    },
  };

  const pi = {
    on(event: string, handler: (event: never, ctx: never) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    getActiveTools: () => options.tools ?? ["read", "bash"],
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: never) => Promise<void> },
    ) => commands.set(name, command.handler),
  };

  extension(pi as never);

  async function fire(event: string, payload: unknown): Promise<unknown> {
    let last: unknown;
    for (const handler of handlers.get(event) ?? [])
      last = await handler(payload as never, ctx as never);
    return last;
  }

  return {
    decided,
    notifications,
    /** The commands the extension registered, so a test can invoke one as Pi does. */
    commands,
    /** Invoke a registered command, with whatever of the context the test needs to add. */
    async command(name: string, overrides: Record<string, unknown> = {}): Promise<void> {
      const handler = commands.get(name);
      if (!handler) throw new Error(`no command named ${name}`);
      await handler("", { ...ctx, ...overrides } as never);
    },
    async start() {
      await fire("session_start", { type: "session_start" });
    },
    /**
     * One turn, as Pi fires it: a fresh options object each time, rebuilt from the base like Pi's
     * own `emitBeforeAgentStart`. That freshness is the reason the extension strips on every turn
     * rather than once, so a harness that reused the object across turns would test the wrong thing.
     */
    async turn(prompt: string): Promise<TurnResult> {
      const systemPromptOptions = {
        cwd: process.cwd(),
        skills: [...ROSTER],
        sections: {} as Record<string, string>,
      };
      const result = (await fire("before_agent_start", {
        type: "before_agent_start",
        prompt,
        systemPromptOptions,
      })) as TurnResult["result"];
      return { skills: systemPromptOptions.skills, sections: systemPromptOptions.sections, result };
    },
    /** Another Pi process starting its own session against the same counter file. */
    async shutdown() {
      await fire("session_shutdown", { type: "session_shutdown" });
    },
  };
}

const EXPANSION =
  '<skill name="review-code" location="/skills/review-code/SKILL.md">\nbody\n</skill>';

function counter(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(AGENT_DIR, COUNTER_FILENAME), "utf8"));
}

beforeEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true });
  mkdirSync(AGENT_DIR, { recursive: true });
});

describe("before_agent_start", () => {
  it("removes the roster and decides on a one-word prompt", async () => {
    const test = harness();
    await test.start();

    const turn = await test.turn("commit");

    expect(turn.skills).toEqual([]);
    expect(turn.sections[GUIDANCE_SECTION]).toBe(GUIDANCE);
    expect(test.decided).toHaveLength(2);
    expect(turn.result?.message?.content).toContain("commit");
  });

  it("routes a one-word prompt that names a skill, and again on the next turn", async () => {
    const test = harness();
    await test.start();

    const first = await test.turn("commit");
    const second = await test.turn("what does this repo do");

    expect(test.decided).toHaveLength(4);
    expect(first.skills).toEqual([]);
    expect(second.skills).toEqual([]);
  });

  it("spends nothing on a short prompt that names no skill, and still strips", async () => {
    const test = harness();
    await test.start();

    const greeting = await test.turn("hi");

    expect(greeting.skills).toEqual([]);
    expect(greeting.sections[GUIDANCE_SECTION]).toBe(GUIDANCE);
    expect(test.decided).toHaveLength(0);

    const next = await test.turn("what does this repo do");

    expect(next.skills).toEqual([]);
    expect(test.decided).toHaveLength(2);
  });

  it("keeps the roster removed on a turn it cannot decide", async () => {
    const test = harness();
    await test.start();
    await test.turn("commit");

    const turn = await test.turn(EXPANSION);

    expect(turn.skills).toEqual([]);
    expect(turn.sections[GUIDANCE_SECTION]).toBe(GUIDANCE);
    expect(test.decided).toHaveLength(2);
  });

  it("strips on the very first turn even when the turn decides nothing", async () => {
    const test = harness();
    await test.start();

    const turn = await test.turn(EXPANSION);

    expect(turn.skills).toEqual([]);
    expect(turn.sections[GUIDANCE_SECTION]).toBe(GUIDANCE);
    expect(test.decided).toHaveLength(0);
  });

  it("leaves the roster alone when disabled in config", async () => {
    writeFileSync(join(AGENT_DIR, "auto-suggest-skill.json"), '{"enabled": false}');
    const test = harness();
    await test.start();

    const turn = await test.turn("review this diff");

    expect(turn.skills).toEqual(ROSTER);
    expect(test.decided).toHaveLength(0);
    expect(test.notifications.join(" ")).toContain("disabled");
  });

  it("clears the roster but adds no guidance when no active tool can load a skill", async () => {
    const test = harness({ tools: ["edit", "write"] });
    await test.start();

    const turn = await test.turn("review this diff");

    expect(turn.skills).toEqual([]);
    expect(turn.sections[GUIDANCE_SECTION]).toBeUndefined();
    expect(test.decided).toHaveLength(0);
  });

  it("strips on a turn whose roster neverSuggest leaves empty", async () => {
    writeFileSync(
      join(AGENT_DIR, "auto-suggest-skill.json"),
      '{"neverSuggest": ["commit", "review-code"]}',
    );
    const test = harness();
    await test.start();

    const turn = await test.turn("review this diff");

    expect(turn.skills).toEqual([]);
    expect(turn.sections[GUIDANCE_SECTION]).toBe(GUIDANCE);
    expect(test.decided).toHaveLength(0);
  });

  it("strips on a turn where no classifier model resolves", async () => {
    const test = harness({ models: [] });
    await test.start();

    const turn = await test.turn("review this diff");

    expect(turn.skills).toEqual([]);
    expect(turn.sections[GUIDANCE_SECTION]).toBe(GUIDANCE);
    expect(test.decided).toHaveLength(0);
  });

  it("suggests immediately from alwaysSuggest without a decision call", async () => {
    writeFileSync(join(AGENT_DIR, "auto-suggest-skill.json"), '{"alwaysSuggest": ["commit"]}');
    const test = harness();
    await test.start();

    const turn = await test.turn("please commit this");

    expect(turn.skills).toEqual([]);
    expect(test.decided).toHaveLength(0);
    expect(turn.result?.message?.content).toContain("commit");
  });
});

describe("the counter file", () => {
  it("records the round the turn ran", async () => {
    const test = harness();
    await test.start();
    await test.turn("commit");
    await test.shutdown();

    expect(counter()).toMatchObject({
      rounds: 1,
      apiCalls: 2,
      suggested: 1,
      skipped: 0,
      sessionIds: ["session-under-test"],
    });
  });

  it("records a skipped turn without a round", async () => {
    const test = harness();
    await test.start();
    await test.turn(EXPANSION);
    await test.shutdown();

    expect(counter()).toMatchObject({ rounds: 0, skipped: 1, suggested: 0 });
  });
});

describe("auto-suggest-skill:status", () => {
  /** A theme stand-in that makes each span visible and records the tokens it was asked for. */
  function themeStub() {
    const tokens: string[] = [];
    return {
      tokens,
      /** The tokens `theme.fg` was called with, and the text it produced. */
      fg: (color: string, text: string) => {
        tokens.push(color);
        return `<${color}>${text}</>`;
      },
      bold: (text: string) => `<b>${text}</b>`,
    };
  }

  it("notifies the plain report when there is no terminal to draw on", async () => {
    const test = harness();
    await test.start();

    await test.command("auto-suggest-skill:status", { mode: "rpc" });

    expect(test.notifications.at(-1)).toContain("auto-suggest-skill");
    expect(test.notifications.at(-1)).toContain("(none yet this session)");
  });

  it("paints a panel from theme tokens only, and closes on Enter", async () => {
    const test = harness();
    await test.start();
    const theme = themeStub();
    let panel = "";
    let closed = false;

    await test.command("auto-suggest-skill:status", {
      mode: "tui",
      ui: {
        notify: () => {},
        custom: async (
          factory: (
            tui: unknown,
            theme: unknown,
            keybindings: unknown,
            done: () => void,
          ) => { render: (width: number) => string[]; handleInput: (data: string) => void },
        ) => {
          const component = factory({}, theme, {}, () => {
            closed = true;
          });
          // Wide enough that the stand-in markup, which counts as visible text, cannot wrap a span.
          panel = component.render(200).join("\n");
          component.handleInput("\r");
        },
      },
    });

    expect(panel).toContain("<b><accent>auto-suggest-skill</></b>");
    expect([...new Set(theme.tokens)].sort()).toEqual(["accent", "border", "dim", "muted", "text"]);
    expect(closed).toBe(true);
    // The panel replaces the notification rather than joining it.
    expect(test.notifications).toHaveLength(0);
  });
});
