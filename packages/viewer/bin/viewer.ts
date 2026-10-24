#!/usr/bin/env node
// cad-viewer: starts and stops the viewer's dev server (Vite, in the background) and opens files from its content
// root in the default browser (the user, 2026-10-24; CLAUDE.md, "The viewer"; README.md, "The viewer"). The running
// server is described in .run/server.json (its process, URL and options); its output goes to .run/server.log.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { contentUrl } from '../server/content.ts';
import { DEFAULTS, envFromOptions, type ServerOptions } from '../server/options.ts';

const viewer = path.resolve(import.meta.dirname, '..');

export const USAGE = `Usage: cad-viewer <command> [options]

Commands:
  start                start the dev server in the background, unless it's running
  stop                 stop it
  status               say whether it's running, and where
  open <file>          start it if needed, then open the file (below the content root) in the default browser

Options (start and open; a running server keeps its own):
  --content-root <dir> the directory served at /content/ (default: the repository's test_corpus/)
  --port <n>           the port (default ${DEFAULTS.port})
  --lan                listen on the LAN too, for phones and tablets (not a secure context over plain http)
  --https <kind>       self (a self-signed certificate) or mkcert (packages/viewer/.cert/cert.pem, key.pem)
  -h, --help           this help
`;

export interface Io { out: (s: string) => void; err: (s: string) => void; runDir?: string; noBrowser?: boolean }

interface State extends ServerOptions { pid: number; url: string }

export interface Args {
  command: string;
  file?: string;
  opts: ServerOptions;
  /** The options given on the command line. */
  given: (keyof ServerOptions)[];
}

export function parseArgs(argv: string[]): Args | string {
  const opts: ServerOptions = { ...DEFAULTS };
  const given: (keyof ServerOptions)[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      const key = ({ '--content-root': 'contentRoot', '--port': 'port', '--lan': 'lan', '--https': 'https' } as const)[
        a as '--port'];
      if (key) given.push(key);
      if (a === '--content-root') opts.contentRoot = path.resolve(value());
      else if (a === '--port') {
        opts.port = Number(value());
        if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) return `bad port: ${argv[i]}`;
      } else if (a === '--lan') opts.lan = true;
      else if (a === '--https') {
        const v = value();
        if (v !== 'self' && v !== 'mkcert') return `--https is self or mkcert: ${v}`;
        opts.https = v;
      } else if (a === '-h' || a === '--help') return 'help';
      else if (a.startsWith('-')) return `unknown option: ${a}`;
      else rest.push(a);
    } catch (e) { return (e as Error).message; }
  }
  const [command, file, ...extra] = rest;
  if (!command) return 'no command';
  if (!['start', 'stop', 'status', 'open'].includes(command)) return `unknown command: ${command}`;
  if (command === 'open' ? file === undefined || extra.length : file !== undefined) {
    return command === 'open' ? 'open takes one file' : `${command} takes no file`;
  }
  return { command, ...(file !== undefined ? { file: path.resolve(file) } : {}), opts, given };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const listening = (port: number) => new Promise<boolean>((resolve) => {
  const s = net.connect(port, '127.0.0.1');
  s.once('connect', () => { s.destroy(); resolve(true); }).once('error', () => resolve(false));
});
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function lanUrls(s: State): string[] {
  if (!s.lan) return [];
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `${s.https === 'none' ? 'http' : 'https'}://${i!.address}:${s.port}/`);
}

async function running(stateFile: string): Promise<State | undefined> {
  if (!fs.existsSync(stateFile)) return undefined;
  const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as State;
  if (alive(s.pid) && await listening(s.port)) return s;
  fs.rmSync(stateFile, { force: true });
  return undefined;
}

async function start(opts: ServerOptions, runDir: string, io: Io, given: Args['given']): Promise<State> {
  const stateFile = path.join(runDir, 'server.json');
  const now = await running(stateFile);
  if (now) {
    const differ = given.filter((k) => now[k] !== opts[k]);
    if (differ.length) throw new Error(`the server is running with another ${differ.join(', ')}: ` +
      `${differ.map((k) => now[k]).join(', ')}; stop it first (cad-viewer stop)`);
    return now;
  }
  if (!fs.statSync(opts.contentRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`no content root: ${opts.contentRoot}`);
  }
  if (await listening(opts.port)) throw new Error(`port ${opts.port} is in use (--port)`);
  fs.mkdirSync(runDir, { recursive: true });
  const log = path.join(runDir, 'server.log');
  const out = fs.openSync(log, 'w');
  const vite = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin/vite.js');
  const child = spawn(process.execPath, [vite, '--config', path.join(viewer, 'vite.config.ts')],
    { cwd: viewer, env: { ...process.env, ...envFromOptions(opts) }, detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.closeSync(out);
  for (let t = 0; t < 300; t++) {
    if (child.exitCode !== null || !alive(child.pid!)) {
      throw new Error(`the server stopped:\n${fs.readFileSync(log, 'utf8').trim()}`);
    }
    if (await listening(opts.port)) {
      const state: State = { ...opts, pid: child.pid!, url: `${opts.https === 'none' ? 'http' : 'https'}://localhost:${
        opts.port}/` };
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
      io.out(`started ${state.url} (content root ${opts.contentRoot}; log ${log})\n`);
      return state;
    }
    await pause(100);
  }
  throw new Error(`the server didn't start within 30 s; see ${log}`);
}

async function stop(runDir: string, io: Io): Promise<void> {
  const stateFile = path.join(runDir, 'server.json');
  const s = await running(stateFile);
  if (!s) return io.out('not running\n');
  // The server was started detached, as its own process group: stop the group.
  try { process.kill(-s.pid, 'SIGTERM'); } catch { process.kill(s.pid, 'SIGTERM'); }
  for (let t = 0; t < 50 && alive(s.pid); t++) await pause(100);
  if (alive(s.pid)) process.kill(s.pid, 'SIGKILL');
  fs.rmSync(stateFile, { force: true });
  io.out(`stopped ${s.url}\n`);
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

/** Runs a command line; returns the exit code (0, 1 for failures, 2 for usage errors). */
export async function main(argv: string[], io: Io): Promise<number> {
  const args = parseArgs(argv);
  if (args === 'help') { io.out(USAGE); return 0; }
  if (typeof args === 'string') { io.err(`cad-viewer: ${args}\n\n${USAGE}`); return 2; }
  const runDir = io.runDir ?? path.join(viewer, '.run');
  try {
    if (args.command === 'stop') await stop(runDir, io);
    else if (args.command === 'status') {
      const s = await running(path.join(runDir, 'server.json'));
      io.out(s ? `running ${[s.url, ...lanUrls(s)].join(' ')} (content root ${s.contentRoot}; https ${s.https})\n`
        : 'not running\n');
    } else {
      const s = await start(args.opts, runDir, io, args.given);
      if (args.command === 'start') {
        for (const u of lanUrls(s)) io.out(`on the LAN: ${u}\n`);
        return 0;
      }
      const rel = contentUrl(s.contentRoot, args.file!);
      if (!rel) throw new Error(`${args.file} isn't below the content root ${s.contentRoot} (or doesn't exist): ` +
        'stop the server and start it with --content-root');
      const url = `${s.url}?url=${encodeURIComponent(rel)}`;
      io.out(`${url}\n`);
      if (!io.noBrowser) openBrowser(url);
    }
    return 0;
  } catch (e) {
    io.err(`cad-viewer: ${(e as Error).message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2),
  { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) });
