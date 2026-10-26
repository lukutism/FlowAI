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
   - `tracker`: Azure DevOps (`org`, `project`) or Jira (`site`, `key`, `email`, `keychain`). An Azure ticket may sit on any
     board of the organisation (a customer's too): it is read from its own board, its code and PRs go to the project's
     repos; a number or a pasted link both work
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
| `flow` | The screen: what needs you, every run, the slots (who holds each, for how long; who waits), the selected run's activity, your plan windows. Starts the background service if needed. |
| `1`–`4` | Tabs: Runs, Queue (who waits for which slot, paused runs, plan deadlines), Metrics (per project), Projects (each project and what it is set to; `↵` opens its settings) |
| Project settings | Sections: General (also Local files: the main checkout's git-ignored files each worktree gets, such as `.claude`, `.mcp.json`, `.npmrc`; Not loaded: CLAUDE.md files above the worktrees meant for another tool), Tickets & PRs, Repos (per repo: checkout, bases, install, ticket match, checks, dev server, patch commands), Agents & limits, Permissions (flow's guard, always; the OS sandbox: on, strict, writable folders, commands outside it, network domains; the reviewer; the plan deadline; denied tools), Devices (also Headless), Customer patches, Naming. `⇥` sections/fields, space or `←→` change, `↵` edits a text or a list (`a` add, `x` remove), `S` shows the changes against the file and saves on `y`: the file is checked first (a mistake is named, nothing written), the old one kept as `.bak`, and new runs use it at once |
| `p` | The project picker: all projects, or one (`fso`, `shop`, …) with its runs; the header shows which |
| `↑` `↓` / `j` `k` | One cursor through Needs attention and the runs: up from the first run goes into Needs attention, down past its last item back to the runs; `⇥` jumps between them; the action keys work on what the cursor is on |
| `n` | The new-run form. No ticket? Leave it empty and describe the task: the plan works from your words, the run and branch are named from their first line (`feat/…` or `fix/…`), and the PR is described by the agent's `pr.md` with no ticket linked. The project is the header's (asked only under all projects). Type the ticket and the rest is filled in from it, each still yours to change: kind (a bug or issue is a fix), base (its release tag), repos (its target platform and tags, by each repo's `match` pattern), customer patch (its customer or board, the app by its area or title through `patchApps`, checked against the base). Base and patch are lists you type into to search (base: every branch and tag, the suggestions first; a ref no branch matches is used as written). Also device, dev server (web and backend repos), model; what will happen and the free slots. It refuses what would fail and says why |
| `a` | Approve a plan: the confirm opens under its item with the defaults (and says if the build will wait for a slot); `y`, or `e` to type other answers |
| `m` | Message a run's agent |
| `S` | Ship a verified run: commit, push, draft PR (a patch run: the write-back) |
| `p` in a run's detail | Port a shipped run to develop (also in the commands) |
| `s` / `g` / `/` | Sort (newest, oldest, latest activity, tokens) / group by stage (`↵` on a group folds it) / filter: `project:fso status:needs-you stage:build` or any text; `esc` clears it |
| `ctrl+k` or `:` | Commands: every action for the selected run, filters, sorts, tabs, typed to narrow |
| `o` in a run's detail | The Agent pane reads like Claude Code: what the agent says (Markdown), each tool as `Name(args)` with what it returned under `⎿`, refusals in red, turn ends. Long prompts from flow and long tool output show their first lines; `o` shows all of them whole, `o` again folds them |
| `↵` / `esc` | A run's detail / back. The run on the left (what it needs, plan and answers, verify and review, the files it changed, the timeline); the live panes on the right: Agent (the session; its message box right under it, a click on Agent types there), Metro (runs with a device), Dev server (runs with one), Shell (a real shell in the worktree: `i` types into it, `ctrl+]` leaves); `[` `]` switch panes, `v` splits a pane with the shell. A click on Plan, a review line or a file (or `P`) opens it as Markdown over the detail; a click on Changes or a changed file (or `d`) opens the change: `j`/`k` move line by line, `[` `]` file by file, `c` comments the line (as on a PR), `x` removes a comment, `S` sends them to the agent as one message (file, line, the code quoted, your words); comments not sent wait for the next time |

The mouse works too: click a tab, a run (a second click opens it), an item's key hint, a confirm's answer, a command,
or any key in the bottom line; the wheel over the table moves the selection. To select text for copying while the
screen has the mouse, hold Option (Terminal, iTerm2) or Shift (most others).

Narrow terminals (80–99 columns) drop the project and token columns, show the stage as a word and one line per item;
below 80×24 the screen says how big it needs to be.

The same as commands: `flow start | approve | message | ship | port | release | stop | done | rm | device | status | log` (`flow start` takes
`--repos a,b`, `--base`, `--kind bug|feature`, `--device android|ios`, `--dev-server`, `--patch <customer>/<app>`, `--model`). With the service running they go through it
and follow the run until it needs you; without it they run in the terminal. An open screen reconnects by itself when
the service restarts.

**Finishing a run.** `flow done <run>` (or Mark done in its commands) takes it off the attention list; `flow rm <run>`
(Remove the run) stops its device and dev server, removes its worktrees and local branch (a PR's branch stays on the
code host) and archives its folder under `runs/.removed`; work never shipped is refused unless you add `--force`.
A removed run's id can start again, so a run whose setup failed doesn't use up its ticket. The service looks at
each draft PR every 10 minutes: merged, the run is done and removed (kept, with a notice saying which `flow port`
to run, while a line the plan's Target lines name has no port yet; a release-line fix whose plan didn't say counts
the default line); closed, it is done and kept. `flow stop <run>`
(Stop the agent's turn) ends a turn now; a message carries the run on.

**Slots.** All runs on the machine share three kinds of slot: agent turns, builds (installs, verify, app builds) and
devices. A run that has to wait shows what for ("waiting for a build slot"); a freed slot goes to the run that has
waited longest. The screen's Resources panel shows who holds and who waits.

**Several repos.** A run can span repos (`repos=mobile,portal`): a worktree each on the same branch, the agent
working from their common folder, verify per repo, and at ship one draft PR per repo that changed.

## A run

**The agent's brief.** Besides each step's message, the agent gets a brief for the whole run as its system prompt
(it stays through compactions): it works unattended (it decides reversible things and records them in the plan),
the goal (the smallest correct change, a PR description a reviewer can judge in ten minutes), what flow does for it
(verify, review, commit, push, PR), the three ways a run ends, and the run's device (argent, on that device only;
screenshots in the run's `evidence/`). Before the start you can add a **note** (how to test, which order or tenant,
what not to touch) and **test logins** (form fields, or `--note` / `--logins-file`): the note goes into the brief;
the logins stay in the run's `logins.md` (readable only by you), the agent is told the file and that they never go
into code, commits or the PR, and ship refuses a change or a PR description that contains them. Logins written in
the ticket (a labelled password, license key, token or PIN, or a password alone under an email) join them: the
ticket the agent reads keeps a pointer instead (also for a ticket it reads through its `ticket` tool), and the
values are masked in the run's transcript and the Agent pane.

**The app's env.** A repo's `appEnv` (`{ "file": ".env", "from": ".env.container.develop", "set": {…}, "login":
{ "license": "OPS_LICENSE_KEY" } }`) gives each run its own env file: written at setup, before the device's build,
from the template with the fixed values and the login step's email, password or license in the named variables. It
is git-excluded (never shipped), and a link to the main checkout's file is replaced by the run's own, never written
through. The setup log names the variables set, not their values.

**How a run ends.** A PR (flow ships what the agent left); `resolution.md` when no change is needed (the run waits
for you: `flow done` confirms it, a message carries it on); `blocked.md` when the agent can't go on (blocked with its
words). A turn that ends with a question to you stops the run as "Agent question" instead of going on to verify.

1. **Setup.** The ticket is read (description, repro steps, comments newest first). A git worktree is created on
   `fix/<id>` or `feat/<id>` from the base; `node_modules` is cloned copy-on-write from the main checkout, then the
   install runs.
2. **Plan.** The agent writes `plan.md` in the run's folder, a definition of done: what changes and why; for a bug,
   how it was reproduced first (`Repro: live | test | mocked | not-reproduced`, a mocked or missing one saying why
   live isn't possible); where the project has release lines, the lines the fix is for (`Target lines`); whether the
   PR may carry tests or comments and who asked (`PR extras`); the problem; the design choice (smallest option, what
   it reuses, what it rejected); acceptance criteria each with its check; what must not change; the approach; a
   decisions log; and open questions, each with a default (`- none — why` when there are none). flow checks every
   part: one that is missing is named back to the agent once, then the run stops for you. A question marked
   `(held)` decides whether behaviour changes; only you answer it.
3. **Plan gate.** No questions: the build starts at once. Questions: the run waits for you; at the deadline
   (30 minutes by default), never for a held question, an advisor decides them: a fresh read-only session (the
   reviewer's kind) given the ticket, the plan and the questions. A question the agent can find out itself (data
   on a test tenant, the code) goes back to it once, to answer in its plan; the rest get the advisor's answers and
   reasons (the defaults when there is no reviewer or its answer can't be read). The PR then lists every decision
   taken without you, "please confirm".
4. **Build.** The agent changes code in its worktree and leaves the changes uncommitted. A message to the agent at any
   stop (a question, a block, a cap, the ship gate, an open PR) carries the run on; afterwards flow puts the gate back,
   verifying again first if the code changed.
5. **Verify.** The project's checks run on the change and on the base (the same worktree with the change stashed).
   Only findings the base doesn't have count, so a base that is already red doesn't block. New findings go back
   to the agent; three reds in a row stop the run for you. Verify also holds the change to only the fix and to what
   may be published (hwt's PR checks): new suppressions; added or edited test files, jest config and new comment
   lines unless the plan's `PR extras` names who asked (a reproduction test goes to the run's `tests/`); local paths
   and edited env files; in `pr.md`, a `Verified:` and a `Not verified:` line, no local paths, no mention of the
   agent; `Repro: live` with its `evidence/before-*.png`. The change is the worktree against HEAD, so a customer
   patch committed under it doesn't count.
6. **Review.** Fresh `claude` sessions in plan mode (they read, never edit, never saw the agent's reasoning), one
   per lens and in parallel (`review.lenses`, all three by default; at most `review.maxTurns` turns each):
   correctness (bugs, the repo's rules, the history of the lines), skeptic (is the root cause proven, every
   criterion met, the plan's and the PR description's claims true; an unproven root cause is a P1) and simplicity
   (what could be cut or reused). Each gets the ticket, the plan, the PR description, the change and the agent's
   earlier answers (`review-answers.md`: `R1: fixed — …` or `R1: not a problem because …`, never published), and
   answers with findings as JSON. Findings under 80% confidence are left
   out; the rest go to the agent to fix or explain. Three reviews with findings stop the run for you.
7. **Ship (you).** flow commits (your commit hooks run), pushes without force, and opens a draft PR linked to the
   ticket, described by the agent's `pr.md`. Merging stays yours. Code that changed after verify is verified again
   instead of shipped. Shipping again after a failed push finishes the job; after a change on an open PR it pushes
   to the same PR.
8. **Port (optional).** The shipped commit is applied to another line in a new run, then verify, review and ship.

### A customer patch run

Some products ship per-customer variants as a patch on top of a release. A run started with
`--patch <customer>/<app>` (and the release as its base) works on that variant:

- **Setup:** the repo's `patches.apply` command stages the customer's patch in the new worktree
  (`{customer} {app} {base} {main}`; its last line of output is the summary, a failure fails the setup with its words).
  flow then commits it locally, in that worktree only: never pushed, and without commit hooks, so nothing reformats
  the customer's code. The agent is told the patch is there.
- **Verify and review** compare against that commit, so they see only the fix, not the patch's own lines.
- **The form** lists the patches (`patches.choices`, one `customer/app` a line) and checks the chosen one against the
  base before the run starts (`patches.check`, exit 0 when there is one).
- **Ship** writes the patch back instead of opening a PR, in two steps. The first `ship` runs `patches.writeBack`
  with `{dryRun}` = `--dry-run` on the whole change (the patch, the fix, new files) and saves its report as
  `patch-report.txt`; the second `ship` runs it for real and the run is done. For the write-back flow moves HEAD back
  off the local commit and puts the worktree back exactly afterwards.

### Adding a repo, syncing with the base

`flow add <run> <repo> [--base <ref>]` (or Add repo in a run's commands) gives a run a repo it lacks while it waits
for you: its own worktree on the run's branch beside the others, from the repo's default base unless given, with the
app env and git-excludes as at setup. The agent's next turn is a new process resuming its session in the same
folder, its brief and settings with the new repo. The brief names the project's other repos, and an agent that needs
one asks for it rather than reading another checkout. `flow sync <run>` (Sync with the base) fetches and merges each
repo's base under the agent's change, which stays uncommitted; a change that conflicts with the new base is left
exactly as it was, the files named.

### A run's own dev server

A run started with `--dev-server` (or Dev server in the form) gets its own dev server for the repo that has one
(`devServer` in the repo's config: a command with `{port}`, the first port to try, the url). It starts during setup
in a build slot on a port no other run holds, and counts as ready once it listens; the agent is told the url, its
output feeds the run detail's Dev server pane, and ship or `flow release` stop it.

With `devServer.browser` (`{ "start": "<page to open>", "hosts": [...], "appPort": 3000, "headed": false }`) the run
also gets its own browser: an agent-browser session (`flow-<run>`) through a proxy in flow's service that sends
`localhost:<appPort>` to the run's own port, so an app pinned to one address (a HUB's dev web bundle loading
`https://localhost:3000`) still reaches this run's dev server. The agent drives it with its `browser` tool
(snapshot, click, fill, press, screenshot into `evidence/`, url, open); open takes only the start page's host,
`hosts` and localhost, since the browser runs outside the agent's sandbox. It starts at the first call and closes
with the dev server.

### A run's own device

A run started with `--device android|ios` gets its own emulator or simulator and its own Metro, so runs never share
one. During setup flow takes a device slot, picks free ports no other run holds, then runs the project's `devices`
commands in order: `prepare` (in the app's worktree: prebuild, pods), `create` (the device; a simulator's UDID is
what it prints), `boot`, `ready` (polled until it exits 0), Metro, and `install` (build, install, point the app at
the run's Metro). The agent is told the device id and the Metro port. Ship stops and removes everything and frees
the slot; `flow release <run>` does so earlier. A device that never becomes ready fails the setup with the last
lines of its log. Placeholders: `{run} {id} {consolePort} {metroPort} {worktree} {runDir} {template}`.
With `devices.headless` on, `{headless}` in the boot command becomes `-no-window -no-audio`: the emulator runs
without its window. `flow device <run>` (or See the device in the browser) opens a page of the service with the
device's screen, live from its own H.264 encoder: click to tap, drag to swipe, type to enter text, Back / Home /
Apps / Dev menu. An iOS simulator is shown there but not driven (simctl has no input). The agent's shell gets
`ANDROID_SERIAL` and `RCT_METRO_PORT`, so `adb` and the React Native CLI talk to the run's own device.
`scripts/avd-clone.sh` (an Android AVD cloned copy-on-write from a template) and `scripts/android-dev-host.sh` (a
React Native debug app pointed at another Metro port) are there for the Android commands.

## Safety

- **The guard** (a PreToolUse hook flow adds to your settings): refuses commits, pushes, history rewrites, branch
  moves and git config changes, writes to the tracker or code host (also through `az rest`, `gh api`), edits outside
  the run's worktree (symlinks followed) and of `.git` or Claude Code's settings files. It reads a shell line the way
  the shell does: quotes, `$(…)`, wrappers such as `env` or `timeout`, `bash -c`. It fails closed, also when it can't
  start. Of the run's folder the agent may write only `plan.md`, `pr.md`, `resolution.md`, `blocked.md`, `learnings.md`,
  `logins.md`, `evidence/` and `tests/` (a reproduction test that doesn't ship); flow's token is not readable.
- **Tickets are data:** their text reaches the agent inside a fence with a random name it can't close, with the rule
  to name anything beyond the change instead of doing it.
- **Denied tools** (per project, `denyTools`): an MCP server's write tools, as permission rules.
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
| `screen.ts`, `screen-page.ts` | A run's device in the browser: frames, H.264, input through adb |
| `service.ts`, `server.ts`, `client.ts`, `daemon.ts` | The background service, its socket and the connection |
| `tui/` | The screen (OpenTUI + React) and its view model; `tui/session.ts` the Agent pane |

Tests: `bun test` (about 270, with a fake agent replaying sanitized real sessions, real git repos, stand-ins for
`az`, `gh`, Jira, devices and Metro, and the screen driven by keys). `scripts/` holds real-world checks:
`review-check.ts`, `sandbox-check.ts`, `device-check.ts`, `ui-snapshot.tsx`.
