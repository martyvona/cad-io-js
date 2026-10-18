// The worker_threads entry.

import { parentPort } from 'node:worker_threads';
import { serve } from './serve.ts';

const port = parentPort!;
serve({ post: (msg, transfer) => port.postMessage(msg, transfer), onMessage: (cb) => void port.on('message', cb) });
