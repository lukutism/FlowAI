# FlowAI

A personal terminal tool that runs Claude Code agents on tickets: it creates an isolated worktree per ticket, drives the agent through plan → build → verify → review → ship, and asks the human only for decisions. It drives the user's own `claude` CLI on their Claude subscription, with their full setup; the only limits are the plan's 5-hour and weekly windows.

Status: a ticket can go from Azure DevOps to a draft PR (one repo); next is a real first ticket, then the terminal UI.

    flow start <project> <ticket>        worktree, plan; continues until it needs you
    flow approve <run> [Q1=<answer> …]   answer the plan's questions
    flow message <run> "<text>"          talk to the run's agent
    flow ship <run>                      commit, push, draft PR (after verify)
    flow status / flow log <run>

Projects are JSON files in ~/.config/flow/projects (see test/fixtures/project.example.json).

Try the connection (real turns on your subscription, with flow's guard):

    bun src/cli.ts try --cwd <a git folder> --model haiku "Create notes.txt, commit and push it" "Write ../outside.txt"

The guard refuses commits, pushes, tracker writes and edits outside the folder; the output shows each refusal and your plan windows.
