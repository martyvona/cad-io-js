#!/usr/bin/env node
import { stepconv } from '../src/stepconv.ts';

process.exitCode = await stepconv(process.argv.slice(2),
  { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin });
