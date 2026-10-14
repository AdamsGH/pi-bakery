/**
 * Prompt text and the two cheap local gates that run before any decision call.
 *
 * The roster is removed through Pi's own structured options rather than by rewriting the rendered
 * prompt. `systemPromptOptions.skills` is what Pi renders the `<available_skills>` block from, and
 * `formatSkillsForPrompt([])` returns an empty string, so an empty array removes the block and its
 * header without touching any other extension's prompt changes. Rewriting `event.systemPrompt`
 * instead would set a forced prompt, which is opaque and would discard other handlers' edits.
 */
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import type { Suggestion } from "./types.js";

/** The `customType` on the injected recommendation, so the transcript can label it. */
export const SUGGESTION_TYPE = "auto-suggest-skill";

/** The `sections` key holding the guidance paragraph. Becomes a `<skill_routing>` tag. */
export const GUIDANCE_SECTION = "skill_routing";

/**
 * A's `onPrompt` guidance, minus its markdown heading: the section tag already supplies one.
 * Deliberately near-verbatim from A, where the wording was adapted from a measured source.
 */
export const GUIDANCE =
  "Skills are not listed in this prompt. When a specialized skill fits the latest user request, a " +
  "skill recommendation message is injected for this turn. If one is present, read that skill's " +
  "file and follow it. If none is present, continue without a skill.";

/**
 * A prompt that is not a task at all, checked locally so it costs nothing: an empty prompt, a bare
 * slash command, and a prompt of three words or fewer that names no installed skill.
 *
 * The word count is a gate on cost, not on length: `hi` and `thanks` should not buy a decision call.
 * Naming a skill is the strongest routing signal there is, though, so a short prompt that contains
 * one — `commit`, `please commit` — routes. Adapted from D's `trivialTurn`, which measured the
 * word count.
 */
export function trivialTurn(text: string, skillNames: Iterable<string> = []): boolean {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("/")) return true;
  if (trimmed.split(/\s+/).length > SHORT_PROMPT_WORDS) return false;
  return !namesASkill(trimmed, skillNames);
}

/** How many words or fewer a prompt may have before it must name a skill to be routed. */
export const SHORT_PROMPT_WORDS = 3;

/**
 * Whether the prompt contains one of these skill names as a whole word. A name is not found inside a
 * longer word — `digital` does not name a skill called `git` — but `commit-this` names `commit`.
 */
function namesASkill(text: string, skillNames: Iterable<string>): boolean {
  for (const name of skillNames) {
    const skill = String(name ?? "").trim();
    if (!skill) continue;
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "iu").test(text)) {
      return true;
    }
  }
  return false;
}

/**
 * Pi expands `/skill:name` before `before_agent_start`, so the prompt arrives as a `<skill>` block
 * rather than as text starting with `/`. The user already picked a skill; there is nothing to route.
 */
export function isSkillExpansion(prompt: string): boolean {
  try {
    return parseSkillBlock(prompt) !== null;
  } catch {
    return false;
  }
}

/**
 * The message injected when a skill was chosen. Worded as a recommendation rather than an
 * instruction so the model can decline it when it does not fit. A's wording.
 */
export function formatSuggestion(result: Suggestion): string | null {
  if (!result.skill || !result.location) return null;
  return [
    "Skill recommendation for this turn:",
    `- skill: ${result.skill}`,
    `- location: ${result.location}`,
    `- reason: ${result.reason}`,
    `Read ${result.location} and follow it. Ignore this if it does not fit the user's request.`,
  ].join("\n");
}
