// The Web Worker entry (a module worker).

import { serve } from './serve.ts';

const scope = globalThis as unknown as {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', cb: (e: MessageEvent) => void): void;
};
serve({ post: (msg, transfer) => scope.postMessage(msg, transfer),
  onMessage: (cb) => scope.addEventListener('message', (e) => cb(e.data)) });
