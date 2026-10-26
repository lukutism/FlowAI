/**
 * How flow runs its own parts: as one compiled binary (a release, `flow <part>`), or from its source (`bun src/…`).
 * A run's guard and its MCP server are started per agent session and per tool call; a release runs them from the
 * binary, so editing the source never reaches a run that is going on.
 */
import { join } from 'node:path'

export const compiled = import.meta.path.startsWith('/$bunfs/')

/** argv that starts a part of flow: guard (a tool call's check), mcp (a run's tool server), serve (the service) */
export function self(part: 'guard' | 'mcp' | 'serve'): string[] {
  if (compiled) return [process.execPath, part]
  return part === 'serve' ? [process.execPath, join(import.meta.dir, 'cli.tsx'), 'serve'] : [process.execPath, join(import.meta.dir, `${part}.ts`)]
}
