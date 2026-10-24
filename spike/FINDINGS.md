# Spike: driving the `claude` CLI on a subscription

24 October 2026 · Claude Code 2.1.310 · signed in with the claude.ai subscription · model haiku for the tests.
Raw event streams are in `recordings/`; they become the fake agent's scripts.

## What works

| Need | Result | Recording |
|---|---|---|
| Runs on the subscription | `system/init` has `apiKeySource: "none"` (OAuth login) | 01 |
| One turn, followed live | `--output-format stream-json --verbose`: init, assistant messages with `tool_use`, user messages with `tool_result`, a final `result` | 01 |
| Session id | on every event; `result.session_id` | 01 |
| Cost and tokens | `result.total_cost_usd`, `result.usage`, `result.modelUsage[model]` (tokens, `costUSD`, `contextWindow`, `costBasis: "list"`): an estimate at list prices, present on the subscription | 01 |
| **Plan usage** | `rate_limit_event.rate_limit_info`: `five_hour` and `seven_day` windows with `utilization` (0.05 / 0.55) and `resetsAt`; `status: "allowed"`; overage `rejected` | 01 |
| Continue a session | `--resume <session_id>`: same session, earlier turns remembered | 02 |
| One process, several messages | `--input-format stream-json`: each JSON user line on stdin is a turn with its own `result`, same session | 03 |
| Trimmed profile (not used: agents keep the full profile) | `--setting-sources project,local --strict-mcp-config --mcp-config <{"mcpServers":{}}>`: 28 tools, 0 MCP servers, 2 plugins (was 306 tools, 12+ MCP, 24 plugins, 6 startup hooks); context at start 24.6k tokens instead of 62k | 04 |
| Our own hooks | `--settings <file>` hooks fire under the trimmed profile: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, PreCompact, PostCompact, SessionEnd | 04 |
| Refuse a tool call in code | PreToolUse hook answering `permissionDecision: "deny"` with a reason: the agent sees the reason; `result.permission_denials` lists the call | 04 |
| Compaction | `system/status` `compacting`, then `system/compact_boundary` with `compact_metadata` (`trigger`, `pre_tokens`, `post_tokens`, `cumulative_dropped_tokens`); PreCompact/PostCompact hooks; `/compact` works as a stream-json message | 04, 05 |
| Spend cap per turn (not used: no dollar budgets) | `--max-budget-usd`: `result.subtype: "error_max_budget_usd"`, `terminal_reason: "budget_exhausted"`, exit 1 | 06 |
| Guard with the full profile | engine hooks via `--settings` merge with the user's own; the deny works | 07 |

(The hook log of test 04 was overwritten while setting up test 07; 04-stream.jsonl still holds that run's compaction events, and 07-hooks.jsonl the hooks of 07.)

## Rules for the engine

- **Subscription only, no extra budget.** Never `--bare` (it requires an API key), never the Agent SDK, never `--max-budget-usd` or any dollar limit. The only limits are the plan's own 5-hour and 7-day windows.
- **Full personal profile.** Agents run with every skill, plugin, MCP server and hook the user has; the engine only adds its own `--settings` (hooks, permissions). Checked in recording 07: 306 tools, 13 MCP servers, 24 plugins, and the engine's PreToolUse hook still fires and denies `git push`. Cost of that: about 62k tokens of context at the start of every session.
- **One process per run** with `--input-format stream-json`. **Write the next message only after the previous `result` arrives.** In recording 04 a third message written while the first turn ran was never answered; sent after a result it was (05).
- **Usage = the plan windows.** Read every `rate_limit_event`: show the 5-hour and 7-day utilization and reset times in the header; stop starting turns near a limit and resume after `resetsAt`. Per run, show tokens (exact, from `usage`), not dollars. The window utilization can't be split per run exactly when runs overlap.
- **`total_cost_usd` is ignored** (a list-price estimate, `costBasis: "list"`); it is not what the subscription charges.
- **The PreToolUse hook is the guard** (no push, stay inside the worktree, no tracker writes). Deny with a reason the agent can act on.
- **The hook script must not block startup.** It reads stdin and appends; the engine socket call needs a short timeout.

## Still open

- A real usage-limit hit: how `rate_limit_event.status` and the `result` look when a window is exhausted (can't be forced; watch for it and record it).
- Interrupting a running turn (init lists `interrupt_*` capabilities): the stdin message shape.
- Permission prompts without a human: `--permission-mode` and `--permission-prompts none` behaviour for tools outside the allow list.
- Whether `--resume` of a process-per-run session works after the process was killed mid-turn.
- Opening the same session interactively (`claude --resume <id>`) while the engine's process is idle, then handing it back.
