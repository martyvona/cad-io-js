// Headless Chrome over the DevTools protocol, for the browser check (test/browser-check.ts) and `cad-viewer shot`
// (the user, 2026-10-25; CLAUDE.md, "The viewer"): Chrome started with a profile of its own, a tab per page, and
// expressions evaluated in it. Real time, polled: --virtual-time-budget doesn't wait for Web Workers (Draco's
// decoder, our tessellation), and without a GPU WebGL needs SwiftShader.

import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** Chrome: $CHROME, else where it usually is on this platform. */
export function defaultChrome(): string {
  if (process.env.CHROME) return process.env.CHROME;
  if (process.platform === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  return 'google-chrome';
}

export interface Tab {
  readonly sessionId: string;
  /** Evaluates an expression in the page (awaiting a promise), within `timeoutMs`; throws what the page threw. */
  evaluate(expression: string, timeoutMs?: number): Promise<unknown>;
  /** Polls an expression until it's truthy (its value), or until `timeoutMs` (undefined). */
  waitFor(expression: string, timeoutMs: number): Promise<unknown>;
  /** The whole page, as Chrome draws it (PNG). */
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

export interface PageOptions {
  /** CSS pixels; with `scale` device pixels per CSS pixel, `mobile` and `touch` for a phone. */
  width?: number;
  height?: number;
  scale?: number;
  mobile?: boolean;
  touch?: boolean;
  /** The system's colour scheme as the page sees it (`prefers-color-scheme`; the viewer's Auto theme follows it). */
  colorScheme?: 'light' | 'dark';
}

export interface Headless {
  /** A DevTools protocol call (in a tab's session if given). */
  send(method: string, params?: object, sessionId?: string): Promise<Record<string, unknown>>;
  /** A new tab, sized, then navigated to `url`. */
  open(url: string, opts?: PageOptions): Promise<Tab>;
  /** Chrome stopped (waited for) and its profile removed. */
  close(): Promise<void>;
}

/** Starts headless Chrome with `profile` as its user data directory (created; removed on close). */
export async function launchChrome(profile: string, opts: { chrome?: string; args?: string[] } = {}):
  Promise<Headless> {
  const chrome = spawn(opts.chrome ?? defaultChrome(), ['--headless=new', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--remote-debugging-port=0', ...(opts.args ?? []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise<string>((resolve, reject) => {
    let s = '';
    chrome.stderr.on('data', (c) => {
      s += c;
      const m = /DevTools listening on (ws:\S+)/.exec(s);
      if (m) resolve(m[1]!);
    });
    chrome.on('error', reject).on('exit', () => reject(new Error(`Chrome exited: ${s}`)));
  });
  const ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map<number, (r: { result?: Record<string, unknown>; error?: unknown }) => void>();
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown };
    if (m.id !== undefined) pending.get(m.id)?.(m);
  };
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<Record<string, unknown>>(
    (resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (m) => {
        pending.delete(id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result ?? {});
      });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const open = async (url: string, o: PageOptions = {}): Promise<Tab> => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' }) as { targetId: string };
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string };
    if (o.width || o.height || o.scale || o.mobile) {
      await send('Emulation.setDeviceMetricsOverride', { width: o.width ?? 1200, height: o.height ?? 800,
        deviceScaleFactor: o.scale ?? 1, mobile: o.mobile ?? false }, sessionId);
    }
    if (o.touch) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
    if (o.colorScheme) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme',
      value: o.colorScheme }] }, sessionId);
    await send('Page.navigate', { url }, sessionId);
    const evaluate = async (expression: string, timeoutMs = 180_000) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const e = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true },
          sessionId), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(
          `the page did not finish within ${timeoutMs / 1000} s`)), timeoutMs); })]) as {
          result: { value: unknown }; exceptionDetails?: { exception?: { description?: string }; text: string } };
        if (e.exceptionDetails) throw new Error(`in the page: ${e.exceptionDetails.exception?.description ??
          e.exceptionDetails.text}`);
        return e.result.value;
      } finally {
        clearTimeout(timer);
      }
    };
    return {
      sessionId,
      evaluate,
      waitFor: async (expression, timeoutMs) => {
        for (const end = Date.now() + timeoutMs; Date.now() < end;) {
          const v = await evaluate(expression, 10_000).catch(() => undefined);
          if (v) return v;
          await new Promise((r) => setTimeout(r, 100));
        }
        return undefined;
      },
      screenshot: async () => {
        const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId) as { data: string };
        return Buffer.from(data, 'base64');
      },
      close: async () => { await send('Target.closeTarget', { targetId }); },
    };
  };

  return {
    send,
    open,
    close: async () => {
      ws.close();
      if (chrome.exitCode === null) await new Promise((resolve) => { chrome.once('exit', resolve); chrome.kill(); });
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
