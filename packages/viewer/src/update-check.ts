// Whether the server has another build than the one running: version.json beside the page holds the version a build
// was made as (vite.config.ts writes it; the dev server serves its own), fetched past every cache and compared with
// VERSION. Any difference counts, older included. Never polled: the viewer is meant to work offline, and traffic of
// its own looks like phoning home. The badge in the controls' title checks when the tab becomes active again (visible
// and focused, after being hidden or unfocused), not at load; About checks when its button is pressed.
//
// The service worker serves the page from its precache, and a reload is served by the worker in charge, so a plain
// reload would show the old build and only fetch the new worker. So once a difference is seen the worker is asked to
// update at once (the new one precaches the build, then takes over, as vite.config.ts sets: it never reloads the page
// itself), and the update counts as ready, a reload then showing it, once that worker is active. version.json is
// left out of the precache, else the worker would answer with the build it has.
//
// Failures: a version.json that doesn't come within FETCH_TIMEOUT, or can't be fetched, is an error the caller says
// or not (About says it, the badge doesn't). A download that fails (the new worker's script not fetched, or its
// install failing, which discards it whole: a worker's precache is all or nothing) drops the version seen, so the
// badge goes and a later check tries again; the check that started it, or joined it, resolves with the error. A
// download that stalls without failing is waited for (the build is about 12 MB; a slow network takes minutes).

import { VERSION } from './version.ts';

/** A check asked for within this of the last is skipped (focus and visibility change together). */
const MIN_GAP = 2_000;
/** How long version.json, and the new worker's script, may take. */
export const FETCH_TIMEOUT = 10_000;

/**
 * What a check found: the same version, another (downloaded by the worker, ready for a reload), nothing asked
 * (within MIN_GAP), or an error (the server not reached, or the download failed), said as a sentence.
 */
export type CheckResult = 'same' | 'other' | 'skipped' | { error: string };

export interface UpdateState {
  /** The server's version, when it differs from the one running. */
  latest?: string;
  /** Whether a reload shows it (the service worker has it, or there's none). */
  ready: boolean;
}

const message = (e: unknown) => e instanceof Error ? e.message : String(e);

/** Rejects with `what` after `ms`, unless `p` settles first. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(what)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** The server's version; throws why not (offline, no answer in time, no version.json, an answer that isn't one). */
export async function serverVersion(timeout = FETCH_TIMEOUT): Promise<string> {
  const url = new URL('version.json', document.baseURI);
  // (The query gets past caches that ignore no-store: the CDN in front of GitHub Pages keeps files 10 minutes.)
  url.searchParams.set('t', String(Date.now()));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: abort.signal });
    if (!r.ok) throw new Error(`the server answered ${r.status}`);
    const v = (await r.json() as { version?: unknown }).version;
    if (typeof v !== 'string' || !v) throw new Error('the server gave no version');
    return v;
  } catch (e) {
    if (abort.signal.aborted) throw new Error(`no answer within ${timeout / 1000} s`);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('offline');
    // (A JSON parse error: the dev server's page, or a build from before version.json.)
    if (e instanceof SyntaxError) throw new Error('the server gave no version');
    // (fetch's own error for a network failure says only "Failed to fetch".)
    if (e instanceof TypeError) throw new Error('no connection');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves once the service worker has the new build (at once if there's none, or nothing new); throws if it can't
 * be had: the script not fetched (within `timeout`), or the new worker's install failing (it's discarded).
 */
async function workerUpdated(timeout = FETCH_TIMEOUT): Promise<void> {
  const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
  if (!reg) return;
  const late = `no answer within ${timeout / 1000} s`;
  try {
    await within(reg.update(), timeout, late);
  } catch (e) {
    if (navigator.onLine === false) throw new Error('offline');
    // (The browser's own error names the scope and script at length.)
    throw e instanceof Error && e.message === late ? e : new Error('its service worker could not be fetched');
  }
  const w = reg.installing ?? reg.waiting;
  if (!w) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      if (w.state !== 'activated' && w.state !== 'redundant') return;
      w.removeEventListener('statechange', done);
      if (w.state === 'activated') resolve();
      else reject(new Error(navigator.onLine === false ? 'offline' : 'its files could not all be fetched'));
    };
    w.addEventListener('statechange', done);
    done();
  });
}

export class UpdateCheck {
  state: UpdateState = { ready: false };
  /** Called whenever the state changes. */
  readonly listeners = new Set<(s: UpdateState) => void>();
  private last = -Infinity;
  /** The worker update in progress: only the latest changes the state. */
  private updating = 0;
  /** The download of `state.latest` in progress, which a check that sees the same version waits for. */
  private download?: Promise<CheckResult>;

  /** How long version.json, and the new worker's script, may take (ms). */
  timeout = FETCH_TIMEOUT;
  private readonly fetchVersion: (timeout: number) => Promise<string>;
  private readonly updateWorker: (timeout: number) => Promise<void>;
  private readonly current: string;

  /** The server's version, the service worker's update and the version running: replaced in tests. */
  constructor(fetchVersion: (timeout: number) => Promise<string> = serverVersion,
    updateWorker: (timeout: number) => Promise<void> = workerUpdated, current = VERSION) {
    this.fetchVersion = fetchVersion;
    this.updateWorker = updateWorker;
    this.current = current;
  }

  /**
   * Checks now, unless a check was made within MIN_GAP (unless `force`); with another version, resolves once the
   * worker has it, or its download has failed.
   */
  async check(force = false): Promise<CheckResult> {
    const now = Date.now();
    if (!force && now - this.last < MIN_GAP) return 'skipped';
    this.last = now;
    let v: string;
    try {
      v = await this.fetchVersion(this.timeout);
    } catch (e) {
      // (As it was: a version seen stays.)
      return { error: `The server could not be reached: ${message(e)}.` };
    }
    if (!this.current) return 'skipped';
    if (v === this.current) {
      this.updating++;
      this.download = undefined;
      this.set({ ready: false });
      return 'same';
    }
    if (v === this.state.latest) return this.download ?? 'other';
    this.set({ latest: v, ready: false });
    const mine = ++this.updating;
    const download = (async (): Promise<CheckResult> => {
      try {
        await this.updateWorker(this.timeout);
      } catch (e) {
        if (this.updating === mine) {
          this.download = undefined;
          this.set({ ready: false });
        }
        return { error: `Version ${v} could not be downloaded: ${message(e)}.` };
      }
      if (this.updating === mine) {
        this.download = undefined;
        this.set({ latest: v, ready: true });
      }
      return 'other';
    })();
    this.download = download;
    return download;
  }

  private set(s: UpdateState): void {
    if (s.latest === this.state.latest && s.ready === this.state.ready) return;
    this.state = s;
    for (const f of this.listeners) f(s);
  }
}

/** What the page's activity looks like, for `onReactivated` (the document; replaced in tests). */
export interface ActivityEnv {
  active(): boolean;
  /** Calls `f` on every change that may make the page active or not. */
  onChange(f: () => void): void;
}

export const documentActivity = (): ActivityEnv => ({
  active: () => document.visibilityState === 'visible' && document.hasFocus(),
  onChange: (f) => {
    document.addEventListener('visibilitychange', f);
    window.addEventListener('focus', f);
    window.addEventListener('blur', f);
  },
});

/** Calls `f` each time the page becomes active after being inactive (not for how it is at first). */
export function onReactivated(env: ActivityEnv, f: () => void): void {
  let was = env.active();
  env.onChange(() => {
    const now = env.active();
    if (now && !was) f();
    was = now;
  });
}

/** The text saying so (the badge's tooltip, About's line). */
export function updateText(s: UpdateState): string | undefined {
  if (!s.latest) return undefined;
  return s.ready ? `Version ${s.latest} is available: reload to update.`
    : `Version ${s.latest} is available (downloading it).`;
}
