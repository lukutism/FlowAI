#!/bin/sh
# A release: flow compiled into one binary at ~/.local/bin/flow, from the committed source, then the service
# restarted on it. Runs (their guard, their tools, the service) then run the release, never the source being edited.
#   scripts/release.sh          typecheck, build, check the binary, install, restart the service
#   scripts/release.sh --test   the whole test suite first (heavy: not while emulators are busy)
set -eu
# run from a git hook (the post-commit release), git's own variables are set: the service must not inherit them (an
# index path that breaks every worktree, an author that overrides a project's identity)
for v in $(env | sed -n 's/^\(GIT_[A-Z_]*\)=.*/\1/p'); do unset "$v"; done
cd "$(dirname "$0")/.."
bin="${FLOW_BIN:-$HOME/.local/bin/flow}"
data="${FLOW_DATA:-$HOME/.local/share/flow}"
[ -z "$(git status --porcelain -- src scripts package.json bun.lock)" ] || { echo "release: commit the source first (a release is a commit)" >&2; exit 1; }
version="$(git rev-parse --short HEAD) $(git log -1 --format=%cs)"

bunx tsc --noEmit -p .
[ "${1:-}" = --test ] && bun test --timeout=20000

mkdir -p dist
bun build --compile --minify src/main.ts --define "process.env.FLOW_RELEASE=\"$version\"" --outfile dist/flow

# the binary does what the source does: the guard refuses a commit and lets ls through, the MCP server answers
w="$(mktemp -d)"
commit='{"tool_name":"Bash","tool_input":{"command":"git commit -am x"},"cwd":"'"$w"'"}'
list='{"tool_name":"Bash","tool_input":{"command":"ls"},"cwd":"'"$w"'"}'
echo "$commit" | FLOW_WORKTREE="$w" dist/flow guard | grep -q '"deny"' || { echo "release: the built guard did not refuse a commit" >&2; exit 1; }
said="$(echo "$list" | FLOW_WORKTREE="$w" dist/flow guard)"
[ -z "$said" ] || { echo "release: the built guard refused ls: $said" >&2; exit 1; }
( echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'; sleep 1 ) | FLOW_RUN=none FLOW_DATA="$w" dist/flow mcp | grep -q '"serverInfo"' || { echo "release: the built MCP server did not answer" >&2; exit 1; }
rm -rf "$w"
[ "$(dist/flow version)" = "$version" ] || { echo "release: the built binary says it is $(dist/flow version)" >&2; exit 1; }

mkdir -p "$(dirname "$bin")"
cp dist/flow "$bin.new" && mv -f "$bin.new" "$bin"
echo "installed $bin ($version)"

# after a restart a setup is done again from the start (an agent is told to carry on): one that is building waits for
# the restart rather than build again; one waiting for a slot doesn't hold it up
waited=0
while "$bin" status 2>/dev/null | grep -q ' setup · running' && [ "$waited" -lt "${FLOW_RELEASE_WAIT:-1200}" ]; do
  [ "$waited" = 0 ] && echo "a run is setting up: the service restarts once it is done"
  sleep 10; waited=$((waited + 10))
done
# the service on the release (open screens reconnect by themselves); a run's next turn uses the release's guard and tools
if [ -f "$data/service.json" ]; then
  pid="$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$data/service.json")"
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -f "$data/service.json" ] || break; sleep 0.5; done
fi
# an open screen starts a service as soon as the old one stops: it may have won with its own; the release takes over
for _ in 1 2 3; do
  nohup "$bin" serve >> "$data/service.log" 2>&1 &
  sleep 2
  pid="$(sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$data/service.json" 2>/dev/null)"
  if [ -n "$pid" ] && ps -o command= -p "$pid" | grep -q "^$bin serve"; then echo "service on the release (pid $pid)"; exit 0; fi
  [ -n "$pid" ] && kill "$pid" 2>/dev/null; sleep 1
done
echo "release: the service did not start on the release; see $data/service.log" >&2; exit 1
