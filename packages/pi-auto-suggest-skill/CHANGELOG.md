# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- The lifetime counter is folded into the file at write time rather than written out from the
  snapshot loaded at session start, so a session no longer erases the rounds another Pi process
  recorded in between.

## [0.1.0] - 2026-10-14

### Added

- Skill routing that removes Pi's `<available_skills>` block and injects at most one skill recommendation per turn, chosen by a classifier model through a gate, a chunked wide ranking and a rerank over `SKILL.md` excerpts.
- A recommendation for a skill the model has already read this session is suppressed, so the model is never told to open a file it has open.
- `model.prefer` selects the classifier model from an ordered list of `provider/id` entries, skipping any entry without working credentials and any whose context window cannot hold the roster, since the catalog contains 4096- and 8192-token models that a full roster does not fit.
- One config file, read from the agent directory and overridden per key by a trusted project file, holding `threshold`, `neverSuggest`, `alwaysSuggest`, `enabled` and `debugLog`.
- `/auto-suggest-skill:status` reports rounds, API calls, outcomes, tokens, cost and latency for the session and for all time, plus the most recent round in full.
- A lifetime counter persisted to the agent directory with an atomic write at mode 0600, and an optional per-call debug log that records no prompt text.
- Prompts that cannot need a skill, and sessions with no tool that can load one, make no decision call and leave Pi's prompt untouched.

[Unreleased]: https://github.com/normful/pi-bakery/commits/main/packages/pi-auto-suggest-skill
[0.1.0]: https://www.npmjs.com/package/@normful/pi-auto-suggest-skill/v/0.1.0
