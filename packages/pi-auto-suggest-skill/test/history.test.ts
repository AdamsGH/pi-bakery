import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { skillsInContext } from "../src/history.js";

const CWD = "/work";

/** A minimal session chain: each entry points at the previous one. */
function chain() {
  const entries: SessionEntry[] = [];
  let counter = 0;
  const add = (entry: Record<string, unknown>): void => {
    const id = `e${++counter}`;
    entries.push({ id, parentId: entries.at(-1)?.id ?? null, timestamp: "", ...entry } as SessionEntry);
  };
  const user = (text: string): void => add({ type: "message", message: { role: "user", content: text } });
  const read = (path: string, isError = false): void => {
    const id = `t${counter}`;
    add({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path } }] } });
    add({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "read", content: [], isError } });
  };
  const readViaBash = (): void =>
    add({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "b1", name: "bash", arguments: { command: "cat /skills/bashed/SKILL.md" } },
        ],
      },
    });
  return { entries, user, read, readViaBash };
}

describe("skillsInContext", () => {
  it("collects a successfully read skill file", () => {
    const c = chain();
    c.user("make slides");
    c.read("/skills/pptx/SKILL.md");
    expect(skillsInContext(c.entries, CWD)).toEqual(new Set(["/skills/pptx/SKILL.md"]));
  });

  it("ignores a read that failed", () => {
    const c = chain();
    c.read("/skills/pptx/SKILL.md", true);
    expect(skillsInContext(c.entries, CWD).size).toBe(0);
  });

  it("resolves a relative path against the working directory", () => {
    const c = chain();
    c.read("skills/local/SKILL.md");
    expect(skillsInContext(c.entries, CWD)).toEqual(new Set(["/work/skills/local/SKILL.md"]));
  });

  it("expands a home-relative path", () => {
    const c = chain();
    c.read("~/skills/home/SKILL.md");
    const found = [...skillsInContext(c.entries, CWD)][0]!;
    expect(found.endsWith("/skills/home/SKILL.md")).toBe(true);
    expect(found.startsWith("~")).toBe(false);
  });

  it("collects a skill loaded through a /skill:name expansion", () => {
    const c = chain();
    c.user('<skill name="review" location="/skills/review/SKILL.md">\nbody\n</skill>');
    expect(skillsInContext(c.entries, CWD)).toEqual(new Set(["/skills/review/SKILL.md"]));
  });

  it("keeps trailing task arguments on a skill expansion from hiding the skill", () => {
    const c = chain();
    c.user('<skill name="review" location="/skills/review/SKILL.md">\nbody\n</skill>\n\nreview the auth code');
    expect(skillsInContext(c.entries, CWD)).toEqual(new Set(["/skills/review/SKILL.md"]));
  });

  it("does not treat a bash cat as a loaded skill, since the router only recommends the read tool", () => {
    const c = chain();
    c.readViaBash();
    expect(skillsInContext(c.entries, CWD).size).toBe(0);
  });

  it("returns an empty set for an empty chain", () => {
    expect(skillsInContext([], CWD).size).toBe(0);
  });

  it("ignores a read with a non-string path", () => {
    const entries = [
      {
        id: "e1",
        parentId: null,
        timestamp: "",
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] },
      },
      {
        id: "e2",
        parentId: "e1",
        timestamp: "",
        type: "message",
        message: { role: "toolResult", toolCallId: "t1", toolName: "read", content: [], isError: false },
      },
    ] as unknown as SessionEntry[];
    expect(skillsInContext(entries, CWD).size).toBe(0);
  });

  it("handles array-form user content", () => {
    const c = chain();
    c.user('<skill name="review" location="/skills/review/SKILL.md">\nbody\n</skill>');
    const entries = c.entries.map((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user") return entry;
      const text = entry.message.content as string;
      return { ...entry, message: { ...entry.message, content: [{ type: "text", text }] } } as SessionEntry;
    });
    expect(skillsInContext(entries, CWD)).toEqual(new Set(["/skills/review/SKILL.md"]));
  });
});
