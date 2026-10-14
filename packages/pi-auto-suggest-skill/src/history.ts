/**
 * Which skills are already in the model's context.
 *
 * A recommendation for a skill the model has already read is noise: it would tell the model to read
 * a file it has open. This replays the active context and collects the skill files reached by a
 * successful `read` call or a `/skill:` expansion.
 *
 * `buildContextEntries()` is compaction- and branch-aware, so a skill read before `/compact` and
 * since summarized away stops counting, and a skill read on another branch never counts.
 */
import os from "node:os";
import path from "node:path";
import { parseSkillBlock, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** Absolute paths of skill files still visible to the model. */
export function skillsInContext(entries: readonly SessionEntry[], cwd: string): Set<string> {
  const seen = new Set<string>();
  /** read toolCallId to the resolved path, so a failed read is not counted. */
  const pending = new Map<string, string>();

  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;

    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type !== "toolCall" || part.name !== "read") continue;
        const raw = part.arguments?.path;
        if (typeof raw !== "string") continue;
        pending.set(part.id, path.resolve(cwd, raw.replace(/^~(?=\/|$)/, os.homedir())));
      }
    } else if (message.role === "toolResult") {
      const resolved = pending.get(message.toolCallId);
      if (resolved && !message.isError) seen.add(resolved);
    } else if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
      try {
        const block = parseSkillBlock(text);
        if (block) seen.add(block.location);
      } catch {
        // A malformed skill envelope is not a loaded skill.
      }
    }
  }

  return seen;
}
