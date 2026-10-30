// The model's sphere while it loads, and zooming to it (the user, 2026-10-30; CLAUDE.md, "Decisions": bounding
// volumes). The sphere is the file's, or the importer's estimate, which grows (its centre kept) as meshes arrive and
// is made again from the meshes when loading ends, so it can shrink; zoom all fits it. While loading, the view is
// zoomed to a second sphere that only grows, so it only ever zooms out: at once when the model's sphere comes and when
// loading ends, else at most once a second, and not at all once the user has moved the view.

import * as THREE from 'three';
import { grow } from 'cad-scene';

/** A sphere as the scene gives one, and whether it's the file's (it doesn't grow). */
export interface Bounds { center: readonly number[]; radius: number; from: string }

export class LoadFit {
  /** The model's sphere, in the display's frame; empty without one. */
  readonly sphere = new THREE.Sphere().makeEmpty();
  /** What automatic zooming fits: grown with the sphere, never shrunk. */
  private readonly loading = new THREE.Sphere().makeEmpty();
  private grows = true;
  private at = -Infinity;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly zoom: (s: THREE.Sphere) => void;
  private readonly moved: () => boolean;
  private readonly now: () => number;

  /**
   * `zoom` fits a sphere in the display's frame; `moved` says whether the user has moved the view since the load
   * began; `now` is the clock, in milliseconds.
   */
  constructor(zoom: (s: THREE.Sphere) => void, moved: () => boolean, now = () => performance.now()) {
    this.zoom = zoom;
    this.moved = moved;
    this.now = now;
  }

  /** A new load: forgets the last; with the model's sphere, zooms to it at once. */
  start(bounds?: Bounds): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.at = -Infinity;
    this.sphere.makeEmpty();
    this.loading.makeEmpty();
    this.grows = true;
    if (!bounds) return;
    this.sphere.set(new THREE.Vector3(...bounds.center), bounds.radius);
    this.loading.copy(this.sphere);
    this.grows = bounds.from !== 'source';
    this.fit(true);
  }

  /** A mesh's placed sphere (the display's frame): the spheres grow to hold it, unless the file gave the sphere. */
  add(s: THREE.Sphere): void {
    if (!this.grows || s.isEmpty()) return;
    let grew = false;
    for (const t of [this.sphere, this.loading]) {
      if (t.isEmpty()) { t.copy(s); grew = true; continue; }
      const g = grow({ center: t.center.toArray(), radius: t.radius }, { center: s.center.toArray(),
        radius: s.radius });
      if (g.radius !== t.radius) { t.radius = g.radius; grew = true; }
    }
    if (grew) this.fit(false);
  }

  /** Loading ended: the sphere made again from the meshes (where it grows), and a last zoom, out only. */
  end(bounds?: Bounds): void {
    if (bounds && this.grows) this.sphere.set(new THREE.Vector3(...bounds.center), bounds.radius);
    this.fit(true);
  }

  /** Stops a zoom put off (a newer load, or none). */
  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private fit(now: boolean): void {
    if (this.moved() || this.loading.isEmpty()) return;
    const wait = this.at + 1000 - this.now();
    if (!now && wait > 0) {
      this.timer ??= setTimeout(() => { this.timer = undefined; this.fit(true); }, wait);
      return;
    }
    this.cancel();
    this.at = this.now();
    this.zoom(this.loading.clone());
  }
}
