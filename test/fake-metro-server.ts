#!/usr/bin/env bun
/** A stand-in for Metro in device tests: answers /status on the given port, like `react-native start`. */
const port = Number(process.argv[2])
Bun.serve({ hostname: '127.0.0.1', port, fetch: req => new Response(new URL(req.url).pathname === '/status' ? 'packager-status:running' : 'not found') })
