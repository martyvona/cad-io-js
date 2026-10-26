// What kind of device the viewer runs on, phone, tablet or desktop (the user, 2026-10-26; CLAUDE.md, "The viewer"):
// it picks the meshing profile by default (coarse on phones and tablets, the library's default elsewhere) and caps the
// import's workers (tessellation.ts). Detected from the screen's size (not the window's: a narrow desktop window is no
// phone), the primary pointer and the touch points, as the user proposed, reordered: a fine pointer with no touch
// first (a desktop, even zoomed so far that its screen is phone-sized in CSS pixels), phones before iPadOS's
// desktop-like user agent (so an iPhone asking for desktop sites stays a phone). The user can override it (B-Rep
// Meshing's Device), remembered in this browser.

import { DEFAULT_MESH_PROFILE, type MeshProfile } from 'cad-scene';

export type DeviceClass = 'phone' | 'tablet' | 'desktop';

/** What the classification reads, so it can be tested apart from a browser. */
export interface DeviceSignals {
  /** The primary pointer is fine (a mouse or trackpad: `(pointer: fine)`), or coarse (a finger). */
  finePointer: boolean;
  coarsePointer: boolean;
  maxTouchPoints: number;
  /** The screen in CSS pixels, either way up. */
  screenWidth: number;
  screenHeight: number;
  userAgent: string;
}

export function classifyDevice(s: DeviceSignals): DeviceClass {
  const short = Math.min(s.screenWidth, s.screenHeight);
  if (s.finePointer && s.maxTouchPoints === 0) return 'desktop';
  // Phones are narrow on their short side, whichever way they're held.
  if (short < 500) return 'phone';
  // iPadOS's Safari (and every iPadOS browser, all WebKit) says it's a Mac; no Mac has touch points.
  if (/Macintosh/.test(s.userAgent) && s.maxTouchPoints > 2) return 'tablet';
  // A finger first: a tablet. (The user's rule for a fine pointer on a large screen, a laptop even with a touch screen,
  // ends as the fallback does: the primary pointer is fine or coarse, not both, so such a laptop never gets here as a
  // tablet.)
  if (s.coarsePointer && s.maxTouchPoints > 2) return 'tablet';
  return 'desktop';
}

/** This browser's signals. */
export function deviceSignals(): DeviceSignals {
  return { finePointer: matchMedia('(pointer: fine)').matches, coarsePointer: matchMedia('(pointer: coarse)').matches,
    maxTouchPoints: navigator.maxTouchPoints || 0, screenWidth: screen.width, screenHeight: screen.height,
    userAgent: navigator.userAgent };
}

/** Each class's meshing profile by default. */
export const DEVICE_PROFILES: Readonly<Record<DeviceClass, MeshProfile>> = { phone: 'coarse', tablet: 'coarse',
  desktop: DEFAULT_MESH_PROFILE };

const KEY = 'cad-viewer.device';
const CLASSES: readonly DeviceClass[] = ['phone', 'tablet', 'desktop'];

/** The class the user chose, if any (storage can be unavailable: then none). */
export function deviceOverride(): DeviceClass | undefined {
  try {
    const v = localStorage.getItem(KEY);
    return CLASSES.includes(v as DeviceClass) ? v as DeviceClass : undefined;
  } catch {
    return undefined;
  }
}

/** Remembers the user's choice (undefined: detect again). */
export function setDeviceOverride(d: DeviceClass | undefined): void {
  try {
    if (d) localStorage.setItem(KEY, d);
    else localStorage.removeItem(KEY);
  } catch {
    // Not remembered; it still applies now.
  }
}
