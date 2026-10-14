# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- A prompt of three words or fewer is now routed only when it names an installed skill. A one-word
  prompt that names a skill (`commit`) reaches the decision call and removes Pi's roster instead of
  being ignored, while `hi` and `thanks` still cost nothing.
- Once a round has removed Pi's roster it stays removed for the rest of the session, instead of a
  later turn that skips putting it back.
- `/auto-suggest-skill:status` opens a styled panel in the TUI — the outcome rates, the unpriced-cost
  caveat and the last round's result each carry their own color — instead of a notification that
  rendered every line in the same dim color. Every other mode still gets the plain notification.
- The report's value column starts at the same offset on every row; the last round's figures were a
  column to the left of the rest.

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
