# flow

A personal terminal tool that runs Claude Code agents on tickets. It takes a ticket from the tracker to a draft pull
request and asks you only for decisions: the plan's open questions, shipping, and anything it can't settle itself.

It drives **your own `claude` CLI**, signed in with **your Claude subscription**, with **your full setup** (skills,
plugins, MCP servers, hooks). There is no API key and no dollar budget; the only limits are your plan's 5-hour and
weekly windows, which flow reads from the CLI after every turn.

## Setup

1. Bun, git, and the `claude` CLI signed in to your subscription. For Azure DevOps, the `az` CLI signed in; for
   GitHub, `gh`; for Jira, an API token in the macOS keychain (`security add-generic-password -U -s flow-jira -a <email> -w`).
2. A project file in `~/.config/flow/projects/<key>.json` (see `test/fixtures/project.example.json`):
   - `tracker`: Azure DevOps (`org`, `project`) or Jira (`site`, `key`, `email`, `keychain`)
   - `forge`: Azure DevOps or GitHub (`owner`)
   - `repos`: each repo's main checkout, default base, release branch patterns, install command and verify steps
     (`tsc`, `eslint`, `jest`, `vitest` or a `command`; `perPackage` runs a step inside each package of a monorepo);
     `default: true` marks the repos a run gets when it names none
   - `naming`: branch (`{type}/{id}`, `{key}`), commit, PR title and body styles
     and, for customer patches, `patches` (below)
   - optionally Claude Code's `sandbox` block, and `devices` (below)
3. Optionally `~/.config/flow/flow.json` with the machine's limits: `{"limits": {"agents": 2, "builds": 2, "devices": 4}}`.
4. `bun install` in this folder, then `bun src/cli.tsx` (or an alias `flow`).

## Daily use

| | |
|---|---|
| `flow` | The screen: what needs you, every run, the slots, the selected run's activity, your plan windows. Starts the background service if needed. |
| `1`–`6` | Tabs: Runs, Queue (who waits for which slot, paused runs, plan deadlines), Resources (slots and plan windows), Activity (every run's events), Metrics (per project), Projects |
| `n` | Start a run: `<project> <ticket> [base] [repos=a,b] [device=android\|ios] [patch=customer/app]` (the ticket: a number or a Jira key) |
| `a` | Approve a plan: the confirm opens under its item with the defaults (and says if the build will wait for a slot); `y`, or `e` to type other answers |
| `m` | Message a run's agent |
| `S` | Ship a verified run: commit, push, draft PR (a patch run: the write-back) |
| `p` | Port a shipped run to develop |
| `s` / `g` / `/` | Sort (newest, oldest, latest activity, tokens) / group by stage (`↵` on a group folds it) / filter: `project:fso status:needs-you stage:build` or any text; `esc` clears it |
| `ctrl+k` or `:` | Commands: every action for the selected run, filters, sorts, tabs, typed to narrow |
| `↵` / `esc` | A run's detail (plan, answers, findings, review, PR, timeline) / back |

The mouse works too: click a tab, a run (a second click opens it), an item's key hint, a confirm's answer, a command,
or any key in the bottom line; the wheel over the table moves the selection. To select text for copying while the
screen has the mouse, hold Option (Terminal, iTerm2) or Shift (most others).

Narrow terminals (80–99 columns) drop the project and token columns, show the stage as a word and one line per item;
below 80×24 the screen says how big it needs to be.

The same as commands: `flow start | approve | message | ship | port | release | status | log` (`flow start` takes
`--repos a,b`, `--base`, `--kind bug|feature`, `--device android|ios`, `--patch <customer>/<app>`). With the service running they go through it
and follow the run until it needs you; without it they run in the terminal.

**Slots.** All runs on the machine share three kinds of slot: agent turns, builds (installs, verify, app builds) and
devices. A run that has to wait shows what for ("waiting for a build slot"); a freed slot goes to the run that has
waited longest. The screen's Resources panel shows who holds and who waits.

**Several repos.** A run can span repos (`repos=mobile,portal`): a worktree each on the same branch, the agent
working from their common folder, verify per repo, and at ship one draft PR per repo that changed.

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

### A customer patch run

Some products ship per-customer variants as a patch on top of a release. A run started with
`--patch <customer>/<app>` (and the release as its base) works on that variant:

- **Setup:** the repo's `patches.apply` command stages the customer's patch in the new worktree
  (`{customer} {app} {base} {main}`; its last line of output is the summary, a failure fails the setup with its words).
  flow then commits it locally, in that worktree only: never pushed, and without commit hooks, so nothing reformats
  the customer's code. The agent is told the patch is there.
- **Verify and review** compare against that commit, so they see only the fix, not the patch's own lines.
- **Ship** writes the patch back instead of opening a PR, in two steps. The first `ship` runs `patches.writeBack`
  with `{dryRun}` = `--dry-run` on the whole change (the patch, the fix, new files) and saves its report as
  `patch-report.txt`; the second `ship` runs it for real and the run is done. For the write-back flow moves HEAD back
  off the local commit and puts the worktree back exactly afterwards.

### A run's own device

A run started with `--device android|ios` gets its own emulator or simulator and its own Metro, so runs never share
one. During setup flow takes a device slot, picks free ports no other run holds, then runs the project's `devices`
commands in order: `prepare` (in the app's worktree: prebuild, pods), `create` (the device; a simulator's UDID is
what it prints), `boot`, `ready` (polled until it exits 0), Metro, and `install` (build, install, point the app at
the run's Metro). The agent is told the device id and the Metro port. Ship stops and removes everything and frees
the slot; `flow release <run>` does so earlier. A device that never becomes ready fails the setup with the last
lines of its log. Placeholders: `{run} {id} {consolePort} {metroPort} {worktree} {runDir} {template}`.
`scripts/avd-clone.sh` (an Android AVD cloned copy-on-write from a template) and `scripts/android-dev-host.sh` (a
React Native debug app pointed at another Metro port) are there for the Android commands.

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
| `git.ts` | Worktrees, commit and push |
| `tracker.ts`, `azure.ts`, `jira.ts`, `forge.ts` | Tickets from Azure DevOps or Jira; draft PRs on Azure DevOps or GitHub |
| `resources.ts` | The machine-wide slots: agents, builds, devices |
| `device.ts` | A run's own device and Metro: ports, background processes, readiness, cleanup |
| `sh.ts` | A project's shell commands, with placeholders |
| `guard.ts`, `settings.ts` | The guard hook and each run's settings |
| `service.ts`, `server.ts`, `client.ts`, `daemon.ts` | The background service, its socket and the connection |
| `tui/` | The screen (OpenTUI + React) and its view model |

Tests: `bun test` (about 270, with a fake agent replaying sanitized real sessions, real git repos, stand-ins for
`az`, `gh`, Jira, devices and Metro, and the screen driven by keys). `scripts/` holds real-world checks:
`review-check.ts`, `sandbox-check.ts`, `device-check.ts`, `ui-snapshot.tsx`.
