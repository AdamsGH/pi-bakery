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
 * Prompts that are not a task at all, checked locally so they cost nothing: an empty prompt and a
 * bare slash command. A word count is deliberately not a gate — a one-word prompt is the strongest
 * routing signal there is when it names a skill (`commit`), and skipping short prompts left both
 * the roster and the decision call behind on a turn the user considered a turn.
 */
export function trivialTurn(text: string): boolean {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return true;
  return trimmed.startsWith("/");
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
