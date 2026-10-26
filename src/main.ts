#!/usr/bin/env bun
/**
 * flow's entry, the one a release is built from: the guard (run on every tool call) and a run's MCP server start
 * without loading the screen; everything else is the CLI.
 */
const part = process.argv[2]
if (part === 'guard') await (await import('./guard.ts')).runGuard()
else if (part === 'mcp') await (await import('./mcp.ts')).runMcp()
else await import('./cli.tsx')

export {}
