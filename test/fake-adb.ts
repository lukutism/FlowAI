#!/usr/bin/env bun
// stands in for adb: screencap prints a tiny PNG; every call is logged to FAKE_ADB_LOG
import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
if (process.env.FAKE_ADB_LOG) appendFileSync(process.env.FAKE_ADB_LOG, JSON.stringify(args) + '\n')
if (args.includes('screencap')) process.stdout.write(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
if (args[0] === 'devices') process.stdout.write('List of devices attached\nemulator-5700\tdevice\nemulator-5790\tdevice\n\n')
if (args.includes('logcat')) process.stdout.write('10-26 11:08:01.000 I/ReactNativeJS( 123): Running "main"\n10-26 11:08:02.000 E/ReactNativeJS( 123): TypeError: x is undefined\n')
