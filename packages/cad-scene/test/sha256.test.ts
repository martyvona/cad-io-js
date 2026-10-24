import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { sha256, sha256Js } from '../src/sha256.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const node = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

test('sha256Js: FIPS 180-4 examples', () => {
  const ascii = (s: string) => new TextEncoder().encode(s);
  assert.equal(hex(sha256Js(ascii(''))), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(hex(sha256Js(ascii('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(hex(sha256Js(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
});

test('sha256Js: as node:crypto at every length around the block and padding boundaries, and a large input', () => {
  const data = randomBytes(3 * 64 + 10);
  for (let n = 0; n <= data.length; n++) assert.equal(hex(sha256Js(data.subarray(0, n))), node(data.subarray(0, n)),
    `length ${n}`);
  const big = randomBytes(3 * 2 ** 20 + 17);
  assert.equal(hex(sha256Js(big)), node(big));
});

test('sha256Js: views at an offset, ArrayBuffers and DataViews hash their own bytes only', () => {
  const data = randomBytes(300);
  const view = new Uint8Array(data.buffer, data.byteOffset + 7, 150);
  assert.equal(hex(sha256Js(view)), node(view));
  assert.equal(hex(sha256Js(new DataView(view.buffer, view.byteOffset, view.byteLength))), node(view));
  assert.equal(hex(sha256Js(view.slice().buffer)), node(view));
  assert.equal(hex(sha256Js(new Uint32Array(view.slice(0, 148).buffer))), node(view.subarray(0, 148)));
});

// (node:test's mock.property hangs on Node's getter for globalThis.crypto, so the property is replaced by hand.)
const withCrypto = async (value: unknown, f: () => Promise<void>) => {
  const own = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
  try { await f(); } finally { Object.defineProperty(globalThis, 'crypto', own); }
};

test('sha256: Web Crypto when it exists, else sha256Js, with the same digests', async () => {
  const data = randomBytes(1000);
  assert.equal(hex(await sha256(data)), node(data));
  // Where crypto.subtle exists, it's used (a stand-in answers here)...
  const calls: unknown[] = [];
  const fake = { subtle: { digest: async (alg: string) => {
    calls.push(alg);
    return new Uint8Array(32).fill(7).buffer;
  } } };
  await withCrypto(fake, async () => assert.equal(hex(await sha256(data)), '07'.repeat(32)));
  assert.deepEqual(calls, ['SHA-256']);
  // ...and where it doesn't (an insecure context: crypto without subtle, or no crypto at all), sha256Js.
  await withCrypto({}, async () => assert.equal(hex(await sha256(data)), node(data)));
  await withCrypto(undefined, async () => assert.equal(hex(await sha256(data)), node(data)));
});
