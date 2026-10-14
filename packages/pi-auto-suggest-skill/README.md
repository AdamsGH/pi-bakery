# @normful/pi-auto-suggest-skill

Pi renders every installed skill's name and description into the system prompt. With a large roster
that is a lot of context spent on skills the turn will not use. This extension removes that block
and asks a small classifier model which skill, if any, the turn needs, then injects at most one
recommendation.

- **Strip** — Pi's `<available_skills>` block is removed, so the roster stops costing context.
- **Route** — a gate, a wide ranking and a rerank over `SKILL.md` excerpts pick at most one skill.
- **Fail open** — any turn the extension cannot decide for leaves Pi's own skill list untouched.

Routing is always on. There is no on-demand tool: the model cannot ask for a skill, it is told.

## Installation

```bash
pi install npm:@normful/pi-auto-suggest-skill
```

Needs a credential for at least one classifier provider: `TYPESAFE_API_KEY`, `OPENROUTER_API_KEY`,
`CLOUDFLARE_API_KEY` with `CLOUDFLARE_ACCOUNT_ID`, `OPENCODE_API_KEY`, `AI_GATEWAY_API_KEY`, or an
`openai` API key. Without one, no model resolves and Pi's skill list stays as it is.

## Commands

| Command                      | Description                                                            |
| ---------------------------- | ---------------------------------------------------------------------- |
| `/auto-suggest-skill:status` | Decision statistics for this session and all time, plus the last round |

## Configuration

One JSON file, read from the global agent directory and overridden per key by a trusted project
file. Neither file is required.

| Path                                  | Scope                      |
| ------------------------------------- | -------------------------- |
| `<agent-dir>/auto-suggest-skill.json` | Global (`~/.pi/agent`)     |
| `.pi/auto-suggest-skill.json`         | Project, only once trusted |

```json
{
  "model": { "prefer": ["typesafe/jev-latest", "openrouter/~typesafe/jev-latest"] },
  "threshold": 0.3,
  "neverSuggest": [],
  "alwaysSuggest": [],
  "enabled": true,
  "debugLog": null
}
```

| Key             | Default                                                  | Meaning                                                                                                                         |
| --------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `model.prefer`  | `typesafe/jev-latest`, `openrouter/~typesafe/jev-latest` | Classifier model IDs to try in order. Entries without credentials, or whose context window cannot hold the roster, are skipped. |
| `threshold`     | `0.3`                                                    | The gate: the mean oriented score below which no skill is suggested at all. Raise it to speak less often.                       |
| `neverSuggest`  | `[]`                                                     | Skill names never suggested. Removed from the roster before routing.                                                            |
| `alwaysSuggest` | `[]`                                                     | Skill names suggested immediately, in order, skipping the decision call entirely.                                               |
| `enabled`       | `true`                                                   | Off switch. When false, Pi's skill list is left alone.                                                                          |
| `debugLog`      | `null`                                                   | A file path. One JSON line per decision call: model, stage, latency, tokens, outcome. Never the prompt.                         |

A model ID is `provider/id` and is split on the first slash, because IDs contain slashes:
`openrouter/typesafe/jev-1.13` is provider `openrouter` with ID `typesafe/jev-1.13`.

## How it decides

1. **Cheap local gates.** An empty prompt, a slash command, a prompt of three words or fewer, a
   `/skill:name` expansion, or a session with neither `read` nor `bash` active — none of these
   makes a decision call, and none of them strips anything.
2. **Gate.** Three questions ride in the first ranking call: does the request act on the user's
   system, would an expert consult a documented procedure, and would prose alone suffice (the last
   inverted). Their mean below `threshold` ends the round with no suggestion.
3. **Wide rank.** One `choice` question per chunk of up to 254 skills, with `none_of_these` offered
   when the roster spans more than one chunk. Each surviving chunk contributes its winner.
4. **Rerank.** The shortlist is re-asked with each candidate's `SKILL.md` excerpt in front of it,
   plus a per-candidate fit question. The winner must clear a fit floor.

A skill the model has already read this session is not recommended again.

## Cost

`/auto-suggest-skill:status` reports tokens always, and a dollar figure only when the model has a
catalog price. Six of the twenty-six shipped classifier models have none — including
`typesafe/jev-latest`, the first default preference — and Pi reports those as `$0` however many
tokens they consume, so the report prints `cost n/a` instead of a misleading zero.

## Inspiration

Derived from [`iamdin/pi-jev-skill-suggestion`](https://github.com/iamdin/pi-jev-skill-suggestion)
(MIT): the strip, the two-stage router, the context dedup and the gate and fit thresholds are that
project's. Its on-demand tool and trigger configuration are removed; the model preference, the
config file, the statistics and the status command are new. The `trivialTurn` prompt filter is from
[`damian87x/jev-pi-skills`](https://github.com/damian87x/jev-pi-skills) (MIT).
