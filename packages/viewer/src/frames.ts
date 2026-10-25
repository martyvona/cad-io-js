// Drawing only on change, at most 30 frames a second (the user, 2026-10-24; CLAUDE.md, "The viewer"): a request
// schedules one frame; a frame whose draw says it isn't finished (controls still moving) schedules the next. Idle,
// nothing runs.

export interface FrameClock {
  now(): number;
  /** requestAnimationFrame, or a stand-in. */
  next(f: () => void): void;
}

const browserClock: FrameClock = { now: () => performance.now(), next: (f) => void requestAnimationFrame(f) };

export class Frames {
  private readonly draw: () => boolean;
  private readonly minIntervalMs: number;
  private readonly clock: FrameClock;
  private scheduled = false;
  private last = -Infinity;
  private idle: (() => void)[] = [];
  frames = 0;

  /** `draw` returns true while it wants another frame. */
  constructor(draw: () => boolean, minIntervalMs = 1000 / 30, clock: FrameClock = browserClock) {
    this.draw = draw;
    this.minIntervalMs = minIntervalMs;
    this.clock = clock;
  }

  /** Draws once more, soon. */
  request(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.clock.next(() => this.tick());
  }

  /** Resolves once no frame is scheduled: at once if none is, else just after the last one is drawn. */
  whenIdle(): Promise<void> {
    if (!this.scheduled) return Promise.resolve();
    return new Promise((resolve) => this.idle.push(resolve));
  }

  private tick(): void {
    // Animation frames come at the display's rate (60 Hz or more): skip them until the interval has passed. A
    // little slack, so that a 60 Hz display gives every second frame rather than every third.
    if (this.clock.now() - this.last < this.minIntervalMs - 2) return this.clock.next(() => this.tick());
    this.scheduled = false;
    this.last = this.clock.now();
    this.frames++;
    if (this.draw()) this.request();
    if (!this.scheduled) for (const f of this.idle.splice(0)) f();
  }
}
