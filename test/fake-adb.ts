#!/usr/bin/env bun
// stands in for adb: screencap prints a tiny PNG; every call is logged to FAKE_ADB_LOG
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (process.env.FAKE_ADB_LOG) appendFileSync(process.env.FAKE_ADB_LOG, JSON.stringify(args) + '\n')
if (args.includes('screencap')) process.stdout.write(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
