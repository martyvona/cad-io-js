// Numbers as a few characters: 999 as it is, then in thousands with one decimal (8.5k, 23.4M, 8.2G, 1.5T), rounded
// first so 999,950 is 1.0M, not 1000.0k. For counts in menu items (ui.ts) and sizes (demo.ts).

/** `n` compacted; under 1000 as it is (rounded). */
export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  const units = ['k', 'M', 'G', 'T'];
  let v = n / 1000, u = 0;
  while (Number(v.toFixed(1)) >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${v.toFixed(1)}${units[u]}`;
}
