import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserOf, clientText, type ClientInfo } from '../src/client-info.ts';

test('the browser, its engine and the OS from a user agent', () => {
  const cases: [string, string][] = [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 ' +
      'Safari/537.36', 'Chrome 142.0.0.0 Blink macOS desktop'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 ' +
      'Safari/537.36 Edg/142.0.3595.53', 'Edge 142.0.3595.53 Blink Windows desktop'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0', 'Firefox 145.0 Gecko Linux desktop'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 ' +
      'Safari/605.1.15', 'Safari 26.1 WebKit macOS desktop'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
      'Version/18.6 Mobile/15E148 Safari/604.1', 'Safari 18.6 WebKit iOS 18.6 mobile'],
    // Chrome on iOS: WebKit underneath.
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
      'CriOS/142.0.7444.77 Mobile/15E148 Safari/604.1', 'Chrome 142.0.7444.77 WebKit iOS 18.6 mobile'],
    ['Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile ' +
      'Safari/537.36', 'Chrome 142.0.0.0 Blink Android 15 mobile'],
    ['Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 ' +
      'Chrome/130.0.0.0 Safari/537.36', 'Samsung Internet 28.0 Blink Android 14 desktop'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 ' +
      'Safari/537.36 OPR/120.0.0.0', 'Opera 120.0.0.0 Blink ChromeOS desktop'],
    ['curl/8.0', 'unknown  unknown unknown desktop'],
  ];
  for (const [ua, want] of cases) {
    const b = browserOf(ua);
    assert.equal(`${b.name} ${b.version} ${b.engine} ${b.os} ${b.mobile ? 'mobile' : 'desktop'}`, want, ua);
  }
});

test("the details as text: dotted keys, numbers' arrays joined, strings' arrays one a line", () => {
  const info = { viewer: { version: '0.3.0' }, device: { detected: 'tablet', chosen: 'desktop' },
    webgl: { limits: { maxViewportDims: [16384, 16384] }, extensions: ['EXT_a', 'OES_b'] },
    features: { webAssembly: true } } as unknown as ClientInfo;
  assert.equal(clientText(info), ['viewer.version: 0.3.0', 'device.detected: tablet', 'device.chosen: desktop',
    'webgl.limits.maxViewportDims: 16384, 16384', 'webgl.extensions: (2)', '  EXT_a', '  OES_b',
    'features.webAssembly: true'].join('\n'));
});
