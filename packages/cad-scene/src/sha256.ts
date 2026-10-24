// SHA-256 (FIPS 180-4) that works in every context: Web Crypto's when there is one, else our own. `crypto.subtle`
// exists only in secure contexts, and a page served over plain http on a LAN (the viewer's default for phones and
// tablets) isn't one; the backends hash their modules and the cache its keys with this, so both keep the same digests
// there (the user, 2026-10-24; see CLAUDE.md, "The viewer").

const K = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);

const bytesOf = (data: BufferSource): Uint8Array => ArrayBuffer.isView(data)
  ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);

/** SHA-256 in JavaScript, synchronously: the fallback where Web Crypto is missing. */
export function sha256Js(data: BufferSource): Uint8Array<ArrayBuffer> {
  const bytes = bytesOf(data);
  const h = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
    0x5be0cd19);
  const w = new Uint32Array(64);
  const block = (view: DataView, at: number) => {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(at + 4 * t);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15]!, b = w[t - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[t] = w[t - 16]! + s0 + w[t - 7]! + s1;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, k = h[7]!;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (k + S1 + ((e & f) ^ (~e & g)) + K[t]! + w[t]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = h[0]! + a; h[1] = h[1]! + b; h[2] = h[2]! + c; h[3] = h[3]! + d;
    h[4] = h[4]! + e; h[5] = h[5]! + f; h[6] = h[6]! + g; h[7] = h[7]! + k;
  };
  // Whole blocks straight from the input; the rest, the 0x80 byte and the length in bits in one or two more.
  const whole = bytes.length - (bytes.length % 64);
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < whole; at += 64) block(input, at);
  const tail = new Uint8Array(bytes.length - whole < 56 ? 64 : 128);
  tail.set(bytes.subarray(whole));
  tail[bytes.length - whole] = 0x80;
  const end = new DataView(tail.buffer);
  end.setUint32(tail.length - 8, Math.floor(bytes.length / 2 ** 29));
  end.setUint32(tail.length - 4, (bytes.length * 8) >>> 0);
  for (let at = 0; at < tail.length; at += 64) block(end, at);
  const out = new Uint8Array(32);
  const o = new DataView(out.buffer);
  h.forEach((x, i) => o.setUint32(4 * i, x));
  return out;
}

/** SHA-256 of the bytes: Web Crypto's where it exists, else `sha256Js`, with the same result. */
export async function sha256(data: BufferSource): Promise<Uint8Array<ArrayBuffer>> {
  const subtle = globalThis.crypto?.subtle;
  return subtle ? new Uint8Array(await subtle.digest('SHA-256', data)) : sha256Js(data);
}
