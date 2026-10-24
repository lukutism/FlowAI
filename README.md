# FlowAI

A personal terminal tool that runs Claude Code agents on tickets: it creates an isolated worktree per ticket, drives the agent through plan → build → verify → review → ship, and asks the human only for decisions. It drives the user's own `claude` CLI on their Claude subscription, with their full setup; the only limits are the plan's 5-hour and weekly windows.

Status: spike done (`spike/FINDINGS.md`); building the engine core. First project: Field Service OS (Azure DevOps, mobile repo).
