import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyDevice, DEVICE_PROFILES, type DeviceSignals } from '../src/device.ts';

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 ' +
  'Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Safari/537.36';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0';
const at = (finePointer: boolean, maxTouchPoints: number, screenWidth: number, screenHeight: number,
  userAgent: string): DeviceSignals => ({ finePointer, coarsePointer: !finePointer && maxTouchPoints > 0,
  maxTouchPoints, screenWidth, screenHeight, userAgent });

test('classifyDevice: phones, tablets and desktops, as they report themselves', () => {
  const cases: [string, DeviceSignals, string][] = [
    ['an Android phone, upright', at(false, 5, 412, 915, ANDROID), 'phone'],
    ['an Android phone, sideways', at(false, 5, 915, 412, ANDROID), 'phone'],
    ['an iPhone', at(false, 5, 393, 852, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)'), 'phone'],
    ['an iPhone asking for desktop sites (a Mac user agent)', at(false, 5, 393, 852, MAC), 'phone'],
    ['an Android tablet', at(false, 10, 800, 1280, ANDROID), 'tablet'],
    ['an iPad (says Mac)', at(false, 5, 820, 1180, MAC), 'tablet'],
    ['an iPad with a trackpad as its primary pointer', at(true, 5, 1024, 1366, MAC), 'tablet'],
    ['an unfolded foldable', at(false, 5, 673, 841, ANDROID), 'tablet'],
    ['a laptop', at(true, 0, 1512, 982, MAC), 'desktop'],
    ['a touch laptop', at(true, 10, 1920, 1080, WINDOWS), 'desktop'],
    ['a 2-in-1 as a tablet (no keyboard)', at(false, 10, 1368, 912, WINDOWS), 'tablet'],
    ['a desktop zoomed to 300 % (a phone-sized screen in CSS pixels)', at(true, 0, 853, 480, WINDOWS), 'desktop'],
    ['no pointer and no touch (a TV)', at(false, 0, 1920, 1080, ANDROID), 'desktop'],
  ];
  for (const [what, s, want] of cases) assert.equal(classifyDevice(s), want, what);
});

test('DEVICE_PROFILES: coarse on phones and tablets, the library\'s default (medium) on desktops', () => {
  assert.deepEqual(DEVICE_PROFILES, { phone: 'coarse', tablet: 'coarse', desktop: 'medium' });
});
