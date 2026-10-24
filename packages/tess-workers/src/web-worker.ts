// The Web Worker side, for a module worker's entry: worker.browser.ts, or an application's own entry that imports its
// backends statically so a bundler includes them (the viewer's tess-worker.ts), passing them as `modules`.

import { serve } from './serve.ts';

export function serveWebWorker(modules: Record<string, Record<string, unknown>> = {}): void {
  const scope = globalThis as unknown as {
    postMessage(msg: unknown, transfer: Transferable[]): void;
    addEventListener(type: 'message', cb: (e: MessageEvent) => void): void;
  };
  serve({ post: (msg, transfer) => scope.postMessage(msg, transfer),
    onMessage: (cb) => scope.addEventListener('message', (e) => cb(e.data)) }, modules);
}
