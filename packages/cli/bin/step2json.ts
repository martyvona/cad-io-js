#!/usr/bin/env node
import { step2json } from '../src/step2json.ts';

process.exitCode = await step2json(process.argv.slice(2),
  { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin });
