import { describe, expect, it } from "vitest";
import { skillReader, toRoster } from "../src/index.js";
import type { Skill } from "@earendil-works/pi-coding-agent";

function skill(name: string, disableModelInvocation = false): Skill {
  return {
    name,
    description: `does ${name}`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { source: "test" },
    disableModelInvocation,
  } as Skill;
}

describe("skillReader", () => {
  it("prefers read over bash, matching Pi's own rule", () => {
    expect(skillReader(["read", "bash"])).toBe("read");
    expect(skillReader(["bash", "read"])).toBe("read");
  });

  it("falls back to bash", () => {
    expect(skillReader(["bash", "edit"])).toBe("bash");
  });

  it("returns undefined when neither is active, which is when Pi omits the skills section", () => {
    expect(skillReader([])).toBe(undefined);
    expect(skillReader(["edit", "write", "grep"])).toBe(undefined);
  });
});

describe("toRoster", () => {
  it("keeps Pi's order", () => {
    expect(toRoster([skill("b"), skill("a")]).map((entry) => entry.name)).toEqual(["b", "a"]);
  });

  it("drops skills the model may not invoke", () => {
    expect(toRoster([skill("a"), skill("b", true)]).map((entry) => entry.name)).toEqual(["a"]);
  });

  it("projects only the three fields the router needs", () => {
    expect(Object.keys(toRoster([skill("a")])[0]!).sort()).toEqual([
      "description",
      "filePath",
      "name",
    ]);
  });

  it("handles a missing skills array", () => {
    expect(toRoster(undefined)).toEqual([]);
  });
});
