// The machine a timing was measured on, for logs and benchmarks: its class (CPU, cores and threads, memory, OS),
// what changes its speed from run to run (power mode, load), and a short fixed workload's speed on one thread and on
// all of them, so timings from different hosts, or from one host in different states, can be told apart. Every log
// with timings starts with hostLine(); `node scripts/host.ts` prints it and the details.
//
// The speed is a pure-JS workload (floating point like curve evaluation, and parsing numbers out of text like a
// Part 21 scan), in units per second; it depends on nothing in the repository, so it stays comparable across commits.
// It's measured with everything else that runs at the time, so a busy machine shows up in it (and in `load`).
//
// Usage: node scripts/host.ts [--json] [--no-speed]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

export interface HostInfo {
  /** The CPU's model name. */
  cpu: string;
  /** Physical cores, and the performance and efficiency cores among them where the CPU has both (else undefined). */
  cores: number;
  performanceCores?: number;
  efficiencyCores?: number;
  /** Hardware threads this process may run on (os.availableParallelism()). */
  threads: number;
  /** Memory in bytes: the machine's, and the cgroup's limit where it's lower (else undefined). */
  memory: number;
  memoryLimit?: number;
  os: string;
  arch: string;
  node: string;
  /** What sets the CPU's speed, as the OS reports it (macOS: pmset's modes; Linux: cpufreq), and the power source. */
  power: string;
  /** The 1-minute load average (0 where the OS has none). */
  load: number;
}

/** Workload units per second, on one thread and on `threads` threads at once. */
export interface HostSpeed {
  single: number;
  threads: number;
  all: number;
}

const read = (f: string): string | undefined => {
  try {
    return fs.readFileSync(f, 'utf8').trim();
  } catch {
    return undefined;
  }
};
const run = (cmd: string, args: string[]): string | undefined => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
};

/** CPU numbers in a Linux cpulist ("0-3,8"). */
function cpuList(s: string | undefined): number[] {
  const out: number[] = [];
  for (const r of (s ?? '').split(',').filter((x) => x)) {
    const [a, b] = r.split('-').map(Number);
    for (let k = a!; k <= (b ?? a!); k++) out.push(k);
  }
  return out;
}

function linuxCores(): Pick<HostInfo, 'cores' | 'performanceCores' | 'efficiencyCores'> {
  const sys = '/sys/devices/system/cpu';
  const online = cpuList(read(`${sys}/online`));
  // A core is the set of threads sharing it; a hybrid CPU lists its kinds' threads (Intel: cpu_core, cpu_atom).
  const coreOf = new Map<number, string>();
  for (const c of online) coreOf.set(c, read(`${sys}/cpu${c}/topology/core_cpus_list`) ?? String(c));
  const cores = new Set(coreOf.values()).size || os.cpus().length;
  const kind = (k: string) => {
    const cpus = cpuList(read(`/sys/devices/${k}/cpus`));
    return cpus.length ? new Set(cpus.map((c) => coreOf.get(c))).size : undefined;
  };
  const p = kind('cpu_core'), e = kind('cpu_atom');
  return p && e ? { cores, performanceCores: p, efficiencyCores: e } : { cores };
}

function linuxMemoryLimit(): number | undefined {
  const rel = read('/proc/self/cgroup')?.split('\n').find((l) => l.startsWith('0::'))?.slice(3);
  const max = rel === undefined ? undefined : read(`/sys/fs/cgroup${rel}/memory.max`);
  const n = max && max !== 'max' ? Number(max) : NaN;
  return Number.isFinite(n) && n < os.totalmem() ? n : undefined;
}

function linuxPower(): string {
  const cpu = '/sys/devices/system/cpu';
  const parts: string[] = [];
  const driver = read(`${cpu}/cpu0/cpufreq/scaling_driver`);
  if (driver) {
    const status = driver === 'intel_pstate' || driver === 'intel_cpufreq' ? read(`${cpu}/intel_pstate/status`) : '';
    parts.push(`${driver}${status ? ` ${status}` : ''}, governor ${read(`${cpu}/cpu0/cpufreq/scaling_governor`)}`);
    const epp = read(`${cpu}/cpu0/cpufreq/energy_performance_preference`);
    if (epp) parts.push(`epp ${epp}`);
  } else {
    parts.push('no cpufreq');
  }
  const noTurbo = read(`${cpu}/intel_pstate/no_turbo`), boost = read(`${cpu}/cpufreq/boost`);
  if (noTurbo !== undefined) parts.push(`turbo ${noTurbo === '0' ? 'on' : 'off'}`);
  else if (boost !== undefined) parts.push(`boost ${boost === '1' ? 'on' : 'off'}`);
  const profile = read('/sys/firmware/acpi/platform_profile');
  if (profile) parts.push(`platform profile ${profile}`);
  // The machine's own supplies (a wireless mouse's battery has scope Device).
  const dir = '/sys/class/power_supply';
  const supplies = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((s) => read(`${dir}/${s}/scope`) !==
    'Device');
  const mains = supplies.filter((s) => read(`${dir}/${s}/type`) === 'Mains');
  const battery = supplies.some((s) => read(`${dir}/${s}/type`) === 'Battery');
  if (battery || mains.length) {
    parts.push(mains.some((s) => read(`${dir}/${s}/online`) === '1') ? 'on AC' : 'on battery');
  }
  return parts.join(', ');
}

function macPower(): string {
  const pm = run('pmset', ['-g']) ?? '';
  const mode = (k: string) => pm.match(new RegExp(`^\\s*${k}\\s+(\\d+)`, 'm'))?.[1];
  const parts: string[] = [];
  const low = mode('lowpowermode'), power = mode('powermode');
  if (low !== undefined) parts.push(`lowpowermode ${low}`);
  if (power !== undefined) parts.push(`powermode ${power} (${['automatic', 'low', 'high'][Number(power)] ?? '?'})`);
  const source = run('pmset', ['-g', 'batt'])?.match(/drawing from '([^']+)'/)?.[1];
  if (source) parts.push(`on ${source === 'AC Power' ? 'AC' : source}`);
  return parts.join(', ') || 'pmset unavailable';
}

/** The host's class and state (no workload run). */
export function hostInfo(): HostInfo {
  const mac = process.platform === 'darwin';
  const sysctl = (k: string) => (mac ? run('sysctl', ['-n', k]) : undefined);
  const num = (k: string) => {
    const n = Number(sysctl(k));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const cores = mac
    ? { cores: num('hw.physicalcpu') ?? os.cpus().length, performanceCores: num('hw.perflevel0.physicalcpu'),
      efficiencyCores: num('hw.perflevel1.physicalcpu') }
    : process.platform === 'linux' ? linuxCores() : { cores: os.cpus().length };
  if (!cores.performanceCores || !cores.efficiencyCores) {
    delete cores.performanceCores;
    delete cores.efficiencyCores;
  }
  const memoryLimit = process.platform === 'linux' ? linuxMemoryLimit() : undefined;
  return {
    cpu: (sysctl('machdep.cpu.brand_string') ?? os.cpus()[0]?.model ?? 'unknown CPU').replace(/\s+/g, ' ').trim(),
    ...cores, threads: os.availableParallelism(), memory: os.totalmem(),
    ...(memoryLimit === undefined ? {} : { memoryLimit }),
    os: `${os.type()} ${os.release()}`, arch: os.arch(), node: process.version,
    power: mac ? macPower() : process.platform === 'linux' ? linuxPower() : 'unknown', load: os.loadavg()[0] ?? 0,
  };
}

/** The memory this process's host lets it use: the cgroup's limit, else the machine's. */
export function usableMemory(info = hostInfo()): number {
  return info.memoryLimit ?? info.memory;
}

// --- The workload ---

const TEXT = (() => {
  const rows: string[] = [];
  for (let k = 0; k < 400; k++) {
    rows.push(`#${k}=CARTESIAN_POINT('',(${(k * 0.731).toFixed(6)},${(-k * 1.17).toFixed(4)},${k}.E-1));`);
  }
  return rows.join('\n');
})();

/** One unit: a few milliseconds of curve evaluation and number scanning; returns a checksum so none of it is dead. */
function unit(): number {
  // De Casteljau on a degree-7 Bezier curve in 3D at 2000 parameters.
  const p = new Float64Array(24);
  for (let k = 0; k < 24; k++) p[k] = Math.sin(k * 0.37) * 10;
  const w = new Float64Array(24);
  let sum = 0;
  for (let i = 0; i < 2000; i++) {
    const t = i / 1999;
    w.set(p);
    for (let r = 7; r > 0; r--) {
      for (let j = 0; j < r; j++) {
        for (let c = 0; c < 3; c++) w[j * 3 + c] = (1 - t) * w[j * 3 + c]! + t * w[(j + 1) * 3 + c]!;
      }
    }
    sum += Math.hypot(w[0]!, w[1]!, w[2]!);
  }
  // The numbers in Part 21 rows, by hand, then by id into a map.
  const ids = new Map<number, number>();
  let id = 0, n = 0, inNumber = false, start = 0;
  for (let i = 0; i < TEXT.length; i++) {
    const ch = TEXT.charCodeAt(i);
    if (ch === 35) { // '#'
      let j = i + 1;
      id = 0;
      while (TEXT.charCodeAt(j) >= 48 && TEXT.charCodeAt(j) <= 57) id = id * 10 + TEXT.charCodeAt(j++) - 48;
      i = j;
      continue;
    }
    // A number starts with a digit, '-' or '.', and goes on through those and 'E'.
    const numeric = (ch >= 48 && ch <= 57) || ch === 45 || ch === 46 || (inNumber && ch === 69);
    if (numeric && !inNumber) { inNumber = true; start = i; }
    if (!numeric && inNumber) {
      inNumber = false;
      n += Number(TEXT.slice(start, i));
      ids.set(id, (ids.get(id) ?? 0) + 1);
    }
  }
  return sum + n + ids.size;
}

/** Runs `count` units, the time it took in ms. */
function timeUnits(count: number): number {
  const t = performance.now();
  let s = 0;
  for (let k = 0; k < count; k++) s += unit();
  if (!Number.isFinite(s)) throw new Error('workload checksum');
  return performance.now() - t;
}

/**
 * The workload's speed: one thread (the best of a few runs after a warm-up), then one worker per thread running
 * the same work at once (all its units over the wall time from the first start to the last end).
 */
export async function hostSpeed(threads = os.availableParallelism()): Promise<HostSpeed> {
  timeUnits(20);
  // Units for about 0.3 s each run, from the warm-up's pace.
  const per = Math.max(10, Math.round(300 / (timeUnits(20) / 20)));
  let best = Infinity;
  for (let r = 0; r < 3; r++) best = Math.min(best, timeUnits(per));
  const single = per / (best / 1000);
  const workers = Array.from({ length: threads }, () => new Worker(new URL(import.meta.url),
    { workerData: { hostSpeedUnits: per } }));
  try {
    // Each worker warms up, says it's ready, and runs on the go signal; the time is the main thread's wall clock.
    await Promise.all(workers.map((w) => new Promise<void>((resolve, reject) => {
      w.once('message', () => resolve());
      w.once('error', reject);
    })));
    const t = performance.now();
    const done = workers.map((w) => new Promise<void>((resolve, reject) => {
      w.once('message', () => resolve());
      w.once('error', reject);
    }));
    for (const w of workers) w.postMessage('go');
    await Promise.all(done);
    const all = (per * threads) / ((performance.now() - t) / 1000);
    return { single, threads, all };
  } finally {
    await Promise.all(workers.map((w) => w.terminate()));
  }
}

const GiB = 2 ** 30;

/** The host in one line (`host: ...`); with the workload's speed unless `speed` is false or $HOST_SPEED is 0. */
export async function hostLine(opts: { speed?: boolean } = {}): Promise<string> {
  const h = hostInfo();
  const cores = h.performanceCores
    ? `${h.cores} cores (${h.performanceCores} performance, ${h.efficiencyCores} efficiency)`
    : `${h.cores} cores`;
  const limit = h.memoryLimit ? ` (limit ${(h.memoryLimit / GiB).toFixed(1)})` : '';
  const mem = `${(h.memory / GiB).toFixed(0)} GiB${limit}`;
  let line = `host: ${h.cpu}, ${cores}, ${h.threads} threads, ${mem}; ${h.os} ${h.arch}; Node ${h.node.slice(1)}; ` +
    `${h.power}; load ${h.load.toFixed(1)}`;
  if ((opts.speed ?? true) && process.env.HOST_SPEED !== '0') {
    const s = await hostSpeed(h.threads);
    line += `; speed ${s.single.toFixed(0)} on 1 thread, ${s.all.toFixed(0)} on ${s.threads}`;
  }
  return line;
}

if (!isMainThread && (workerData as { hostSpeedUnits?: number } | null)?.hostSpeedUnits) {
  const per = (workerData as { hostSpeedUnits: number }).hostSpeedUnits;
  timeUnits(20);
  parentPort!.postMessage('ready');
  parentPort!.once('message', () => {
    timeUnits(per);
    parentPort!.postMessage('done');
  });
} else if (import.meta.main) {
  const json = process.argv.includes('--json'), speed = !process.argv.includes('--no-speed');
  if (json) {
    console.log(JSON.stringify({ ...hostInfo(), ...(speed ? { speed: await hostSpeed() } : {}) }, null, 2));
  } else {
    console.log(await hostLine({ speed }));
  }
}
