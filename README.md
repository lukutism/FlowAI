# FlowAI

A personal terminal tool that runs Claude Code agents on tickets: it creates an isolated worktree per ticket, drives the agent through plan → build → verify → review → ship, and asks the human only for decisions. It drives the user's own `claude` CLI on their Claude subscription, with their full setup; the only limits are the plan's 5-hour and weekly windows.

Status: engine core and the Claude connection are built; next is the first project end to end (Azure DevOps, one repo).

Try the connection (real turns on your subscription, with flow's guard):

    bun src/cli.ts try --cwd <a git folder> --model haiku "Create notes.txt, commit and push it" "Write ../outside.txt"

The guard refuses commits, pushes, tracker writes and edits outside the folder; the output shows each refusal and your plan windows.
