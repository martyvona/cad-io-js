#!/usr/bin/env node
// cad-viewer: starts and stops the viewer's dev server (Vite, in the background), opens files from its content
// root in the default browser, and renders them headlessly to PNG (`shot`, through headless Chrome and the page's
// automation interface, src/automation.ts) (the user, 2026-10-24 and 25; CLAUDE.md, "The viewer"; README.md, "The
// viewer"). The running server is described in .run/server.json (its process, URL and options); its output goes to
// .run/server.log.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CONTENT_PREFIX, contentUrl } from '../server/content.ts';
import { launchChrome, type Tab } from '../server/headless.ts';
import { DEFAULTS, envFromOptions, type ServerOptions } from '../server/options.ts';

const viewer = path.resolve(import.meta.dirname, '..');

export const USAGE = `Usage: cad-viewer <command> [options]

Commands:
  start                start the dev server in the background, unless it's running
  stop                 stop it
  status               say whether it's running, and where
  open <file>          start it if needed, then open the file (below the content root) in the default browser
  shot <file>          start it if needed, then render the file (below the content root) in headless Chrome to a
                       PNG, and say what the page reports (the server is left running)
  replay <recording>   start it if needed, then replay a recording (Recording, in the page) in headless Chrome at
                       its window's size: what diverged from it, and the view at the end as a PNG (-o); local files
                       it opened are looked for below the content root, by name and size; exit 3 if anything diverged

Options for shot:
  -o <png>             where the PNG goes (default: the file's name with .png, in the current directory)
                       (replay: -o, --json, --theme and --chrome too)
  --size <w>x<h>       the view in pixels (default 1200x800; one pixel per CSS pixel)
  --view <name>        front, back, left, right, top, bottom or iso (default: as the page fits it)
  --state <query>      more of the view, as in a link's address: "cut=x:10&hide=as1/plate&ao=0" (README.md)
  --json <file>        also write the page's state, the view's link and its status line there ("-": standard output)
  --theme <theme>      dark (the default), light, or auto (the viewer's Auto: headless Chrome's preference, light)
  --background <color> the view's background instead of the theme's, #rrggbb (white for pictures on a white page)
  --chrome <path>      Chrome (default: $CHROME, or where it usually is)

Options (start, open and shot; a running server keeps its own):
  --content-root <dir> the directory served at /content/ (default: the repository's test_corpus/)
  --port <n>           the port (default ${DEFAULTS.port})
  --lan                listen on the LAN too, for phones and tablets (not a secure context over plain http)
  --https <kind>       self (a self-signed certificate) or mkcert (packages/viewer/.cert/cert.pem, key.pem)
  -h, --help           this help
`;

export interface Io { out: (s: string) => void; err: (s: string) => void; runDir?: string; noBrowser?: boolean }

interface State extends ServerOptions { pid: number; url: string }

export interface ShotOptions {
  out?: string;
  width: number;
  height: number;
  view?: string;
  state?: string;
  json?: string;
  chrome?: string;
  /** dark (the default), light, or auto: headless Chrome's own preference, which the viewer's Auto follows. */
  theme?: 'dark' | 'light' | 'auto';
  /** The view's background instead of the theme's (0xrrggbb). */
  background?: number;
}

export interface Args {
  command: string;
  file?: string;
  opts: ServerOptions;
  shot: ShotOptions;
  /** The options given on the command line. */
  given: (keyof ServerOptions)[];
}

export function parseArgs(argv: string[]): Args | string {
  const opts: ServerOptions = { ...DEFAULTS };
  const shot: ShotOptions = { width: 1200, height: 800 };
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
      } else if (a === '-o') shot.out = path.resolve(value());
      else if (a === '--size') {
        const [w, h] = (/^(\d+)x(\d+)$/.exec(value()) ?? []).slice(1).map(Number);
        if (!w || !h || [w, h].some((x) => x < 16 || x > 8192)) return `--size is <w>x<h>, 16 to 8192: ${argv[i]}`;
        [shot.width, shot.height] = [w, h];
      } else if (a === '--view') shot.view = value();
      else if (a === '--state') shot.state = value().replace(/^\?/, '');
      else if (a === '--json') shot.json = value();
      else if (a === '--chrome') shot.chrome = value();
      else if (a === '--theme') {
        const v = value();
        if (v !== 'dark' && v !== 'light' && v !== 'auto') return `--theme is dark, light or auto: ${v}`;
        shot.theme = v;
      } else if (a === '--background') {
        const v = value();
        if (!/^#?[0-9a-f]{6}$/i.test(v)) return `--background is #rrggbb: ${v}`;
        shot.background = parseInt(v.replace('#', ''), 16);
      }
      else if (a === '-h' || a === '--help') return 'help';
      else if (a.startsWith('-')) return `unknown option: ${a}`;
      else rest.push(a);
    } catch (e) { return (e as Error).message; }
  }
  const [command, file, ...extra] = rest;
  if (!command) return 'no command';
  if (!['start', 'stop', 'status', 'open', 'shot', 'replay'].includes(command)) {
    return `unknown command: ${command}`;
  }
  const takesFile = command === 'open' || command === 'shot' || command === 'replay';
  if (takesFile ? file === undefined || extra.length : file !== undefined) {
    return takesFile ? `${command} takes one file` : `${command} takes no file`;
  }
  return { command, ...(file !== undefined ? { file: path.resolve(file) } : {}), opts, shot, given };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/**
 * Whether something listens on a port of either loopback address: Vite listens on what 'localhost' resolves to first,
 * 127.0.0.1 or ::1, which differs between machines and over time (on this one, ::1 since 2026-10-27).
 */
const listening = async (port: number) => (await Promise.all(['127.0.0.1', '::1'].map((host) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect(port, host);
    s.once('connect', () => { s.destroy(); resolve(true); }).once('error', () => resolve(false));
  })))).some((up) => up);
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

/** Evaluates in a page that may reload once (Vite optimizing its dependencies on first use), until `timeoutMs`. */
async function settled(tab: Tab, expression: string, timeoutMs: number): Promise<unknown> {
  for (const end = Date.now() + timeoutMs; ;) {
    try {
      return await tab.evaluate(expression, Math.max(1000, end - Date.now()));
    } catch (e) {
      if (Date.now() > end || !/context|destroyed|not defined|undefined/i.test((e as Error).message)) throw e;
      await pause(250);
    }
  }
}

/**
 * The colour scheme headless Chrome reports for a shot's theme: the page starts with the viewer's Auto theme (a new
 * profile remembers no choice), which follows it; auto leaves Chrome's own (light).
 */
const scheme = (o: ShotOptions): { colorScheme?: 'light' | 'dark' } => (o.theme ?? 'dark') === 'auto' ? {}
  : { colorScheme: o.theme === 'light' ? 'light' : 'dark' };

/** A file's `?model=`: its path within the content root, from its URL path below /content/. */
const modelPath = (rel: string) => rel.slice(CONTENT_PREFIX.length).split('/').map(decodeURIComponent).join('/');

/** Renders a file headlessly: its PNG, and what the page says. */
async function takeShot(s: State, file: string, o: ShotOptions, io: Io): Promise<void> {
  const rel = contentUrl(s.contentRoot, file);
  if (!rel) throw new Error(`${file} isn't below the content root ${s.contentRoot} (or doesn't exist): ` +
    'stop the server and start it with --content-root');
  const q = new URLSearchParams({ model: modelPath(rel) });
  q.set('deterministic', '');
  const extra = new URLSearchParams(o.state ?? '');
  // The tree closed, so the view is the whole page, unless the state says otherwise.
  if (!extra.has('tree')) q.set('tree', '0');
  if (o.view) q.set('view', o.view);
  for (const [k, v] of extra) q.append(k, v);
  const page = `${s.url}?${q}`;
  const headless = await launchChrome(fs.mkdtempSync(path.join(os.tmpdir(), 'cad-viewer-shot-')),
    { chrome: o.chrome, args: s.https === 'none' ? [] : ['--ignore-certificate-errors'] });
  try {
    const tab = await headless.open(page, { width: o.width, height: o.height, scale: 1, ...scheme(o) });
    await settled(tab, 'cadViewer.ready.then(() => cadViewer.idle()).then(() => true)', 600_000);
    const r = await tab.evaluate(`({ state: cadViewer.state(), link: cadViewer.link(),
      status: document.getElementById('status').textContent,
      error: document.getElementById('status').classList.contains('error'),
      png: cadViewer.state().model ? (${o.background === undefined ? '' : `viewer.setBackground(${o.background}), `
      }cadViewer.screenshot()) : null })`) as { state: { model?: { name: string;
      triangles: number } }; link: string; status: string; error: boolean; png: string | null };
    const { png, ...report } = r;
    if (o.json) {
      const text = JSON.stringify({ page, ...report }, null, 2) + '\n';
      if (o.json === '-') io.out(text);
      else fs.writeFileSync(o.json, text);
    }
    if (!png) throw new Error(`no model: ${r.status}`);
    const out = o.out ?? path.resolve(path.basename(file).replace(/\.[^.]*$/, '') + '.png');
    fs.writeFileSync(out, Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64'));
    if (r.error) io.err(`cad-viewer: the page says: ${r.status}\n`);
    if (o.json !== '-') io.out(`${out}: ${o.width}x${o.height}, ${r.state.model!.name}, ${
      r.state.model!.triangles.toLocaleString('en')} triangles\n${r.link}\n`);
  } finally {
    await headless.close();
  }
}

/** The files below a directory, by name (symbolic links not followed). */
function filesBelow(dir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) out.set(e.name, [...out.get(e.name) ?? [], f]);
    }
  };
  walk(dir);
  return out;
}

/** Replays a recording headlessly: what diverged, and the view at the end. Returns the exit code. */
async function replayRecording(s: State, file: string, o: ShotOptions, io: Io): Promise<number> {
  const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as { format?: string; window: { width: number;
    height: number; scale: number }; events: { type: string; url?: string; files?: { name: string; size: number }[]
    }[] };
  if (rec.format !== 'cad-viewer-recording') throw new Error(`${file} isn't a cad-viewer recording`);
  // Local files, by name and size below the content root, as URLs there.
  const urls: Record<string, string> = {};
  let below: Map<string, string[]> | undefined;
  for (const e of rec.events) for (const f of e.type === 'load' ? e.files ?? [] : []) {
    below ??= filesBelow(s.contentRoot);
    const match = (below.get(f.name) ?? []).find((g) => fs.statSync(g).size === f.size);
    const rel = match && contentUrl(s.contentRoot, match);
    if (rel) urls[f.name] = rel;
    else io.err(`cad-viewer: ${f.name} (${f.size} bytes) isn't below the content root ${s.contentRoot}\n`);
  }
  const headless = await launchChrome(fs.mkdtempSync(path.join(os.tmpdir(), 'cad-viewer-replay-')),
    { chrome: o.chrome, args: s.https === 'none' ? [] : ['--ignore-certificate-errors'] });
  try {
    const tab = await headless.open(s.url, { width: rec.window.width, height: rec.window.height,
      scale: rec.window.scale, ...scheme(o) });
    await settled(tab, 'cadViewer.ready.then(() => true)', 600_000);
    const r = await tab.evaluate(`cadViewer.replay(${JSON.stringify(rec)}, { urls: ${JSON.stringify(urls)} })
      .then(async (report) => { await cadViewer.idle(); return { report, state: cadViewer.state(),
      png: cadViewer.state().model ? cadViewer.screenshot() : null }; })`, 3_600_000) as { report: {
      events: number; applied: number; divergences: string[] }; state: unknown; png: string | null };
    if (o.json) {
      const text = JSON.stringify({ report: r.report, state: r.state }, null, 2) + '\n';
      if (o.json === '-') io.out(text);
      else fs.writeFileSync(o.json, text);
    }
    const out = o.out ?? path.resolve(path.basename(file).replace(/\.[^.]*$/, '') + '.png');
    if (r.png) fs.writeFileSync(out, Buffer.from(r.png.replace(/^data:image\/png;base64,/, ''), 'base64'));
    if (o.json !== '-') {
      io.out(`replayed ${r.report.applied} of ${r.report.events} events${r.png ? `; the end: ${out}` : ''}\n`);
      for (const d of r.report.divergences) io.out(`diverged: ${d}\n`);
      if (!r.report.divergences.length) io.out('as recorded\n');
    }
    return r.report.divergences.length ? 3 : 0;
  } finally {
    await headless.close();
  }
}

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

/** Runs a command line; returns the exit code (0, 1 for failures, 2 for usage errors, 3 for a replay that
 * diverged). */
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
      if (args.command === 'shot') {
        await takeShot(s, args.file!, args.shot, io);
        return 0;
      }
      if (args.command === 'replay') return await replayRecording(s, args.file!, args.shot, io);
      const rel = contentUrl(s.contentRoot, args.file!);
      if (!rel) throw new Error(`${args.file} isn't below the content root ${s.contentRoot} (or doesn't exist): ` +
        'stop the server and start it with --content-root');
      const url = `${s.url}?${new URLSearchParams({ model: modelPath(rel) })}`;
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
