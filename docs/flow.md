# flow

A personal terminal tool that runs Claude Code agents on tickets. It takes a ticket from the tracker to a draft pull
request and asks you only for decisions: the plan's open questions, shipping, and anything it can't settle itself.

It drives **your own `claude` CLI**, signed in with **your Claude subscription**, with **your full setup** (skills,
plugins, MCP servers, hooks). There is no API key and no dollar budget; the only limits are your plan's 5-hour and
weekly windows, which flow reads from the CLI after every turn.

## Setup

1. Bun, git, and the `claude` CLI signed in to your subscription. For Azure DevOps projects, the `az` CLI signed in.
2. A project file in `~/.config/flow/projects/<key>.json` (see `test/fixtures/project.example.json`): tracker, code
   host, the repo's main checkout, its default base and release branch patterns, the install command, the verify
   steps, and optionally Claude Code's `sandbox` block.
3. `bun install` in this folder, then `bun src/cli.tsx` (or an alias `flow`).

## Daily use

| | |
|---|---|
| `flow` | The screen: what needs you, every run, your plan windows. Starts the background service if needed. |
| `n` | Start a run: `<project> <ticket number> [base]` |
| `a` | Approve a plan: its questions with their defaults; `y`, or `e` to type other answers |
| `m` | Message a run's agent |
| `s` | Ship a verified run: commit, push, draft PR |
| `p` | Port a shipped run to develop |
| `↵` / `esc` | A run's detail (plan, answers, findings, review, PR, timeline) / back |

The same as commands: `flow start | approve | message | ship | port | status | log`. With the service running they
go through it and follow the run until it needs you; without it they run in the terminal.

## A run

1. **Setup.** The ticket is read (description, repro steps, comments newest first). A git worktree is created on
   `fix/<id>` or `feat/<id>` from the base; `node_modules` is cloned copy-on-write from the main checkout, then the
   install runs.
2. **Plan.** The agent writes `plan.md` in the run's folder: what changes and why, the approach, and open questions,
   each with a default. A question marked `(held)` decides whether behaviour changes; only you answer it.
3. **Plan gate.** No questions: the build starts at once. Questions: the run waits for you; at the deadline
   (30 minutes by default) the service takes the defaults, never for a held question.
4. **Build.** The agent changes code in its worktree and leaves the changes uncommitted.
5. **Verify.** The project's checks run on the change and on the base (the same worktree with the change stashed).
   Only findings the base doesn't have count, so a base that is already red doesn't block. New findings go back
   to the agent; three reds in a row stop the run for you.
6. **Review.** A fresh `claude` session in plan mode (it reads, never edits, never saw the agent's reasoning) gets
   the ticket, the plan and the change, and answers with findings as JSON. Findings under 80% confidence are left
   out; the rest go to the agent to fix or explain. Three reviews with findings stop the run for you.
7. **Ship (you).** flow commits (your commit hooks run), pushes without force, and opens a draft PR linked to the
   ticket, described by the agent's `pr.md`. Merging stays yours.
8. **Port (optional).** The shipped commit is applied to another line in a new run, then verify, review and ship.

## Safety

- **The guard** (a PreToolUse hook flow adds to your settings): refuses commits, pushes, history rewrites, writes to
  the tracker or code host, and edits outside the run's worktree and folder. It fails closed.
- **The OS sandbox** (per project): shell commands can write only in the run's folders and the build caches.
- **Never billed:** a session that isn't on your subscription is stopped before it does anything.
- **Usage limits:** turns start only while both plan windows have room (90% / 95% by default); a turn that hits the
  limit is paused until the reset and sent again.
- **One action per run** at a time; the service's socket is localhost-only and needs a token only you can read.
- **Everything is recorded:** every step is an event with who did it (you, the agent, the engine) and when.

## How it is built

TypeScript on Bun. One process per run drives `claude -p --input-format stream-json --output-format stream-json`.

| Module | Role |
|---|---|
| `run.ts` | The run state machine: a run's state is a fold over its events |
| `store.ts` | The append-only SQLite event log; refuses events the run can't take |
| `agent/claude.ts`, `agent/stream.ts` | The CLI process per run; its stream reduced to session, tools, refusals, compactions, plan usage, results |
| `runner.ts`, `turns.ts`, `usage.ts` | Turns: plan windows, parallel slots, usage-limit retries |
| `pipeline.ts`, `prompts.ts`, `plan.ts` | The steps of a run and what the agent is told |
| `verify.ts`, `review.ts` | Checks against the base; the independent review |
| `git.ts`, `azure.ts` | Worktrees, commit and push; work items and draft PRs |
| `guard.ts`, `settings.ts` | The guard hook and each run's settings |
| `service.ts`, `server.ts`, `client.ts`, `daemon.ts` | The background service, its socket and the connection |
| `tui/` | The screen (OpenTUI + React) and its view model |

Tests: `bun test` (about 200, with a fake agent replaying sanitized real sessions, real git repos, a stand-in `az`,
and the screen driven by keys). `scripts/` holds real-world checks: `review-check.ts`, `sandbox-check.ts`,
`ui-snapshot.tsx`.
