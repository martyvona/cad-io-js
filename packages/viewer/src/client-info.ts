// What the viewer runs on, for recordings (recorder.ts's Recording.client) and About's Client details (as text to
// copy): the device's class, the browser and OS, the screen and window, input and display preferences, the CPU's
// threads and memory, WebGL's version, GPU and limits, and the platform features the viewer leans on. Nothing that
// says who or where the user is: no language, time zone, clock, address or storage contents (the user agent, which a
// recording has always carried, says only the browser and OS).

import type * as THREE from 'three';
import { classifyDevice, deviceOverride, deviceSignals, type DeviceClass } from './device.ts';
import { showDialog } from './dialog.ts';
import { VERSION } from './version.ts';

export interface ClientInfo {
  viewer: { version: string };
  device: { detected: DeviceClass; chosen?: DeviceClass; inUse?: DeviceClass };
  browser: { name: string; version: string; engine: string; os: string; mobile: boolean; userAgent: string };
  screen: { width: number; height: number; availWidth: number; availHeight: number; pixelRatio: number;
    colorDepth: number; orientation?: string };
  window: { width: number; height: number };
  input: { pointer: 'fine' | 'coarse' | 'none'; anyFinePointer: boolean; hover: boolean; maxTouchPoints: number };
  display: { colorScheme: 'dark' | 'light'; reducedMotion: boolean; colorGamut: string; dynamicRange: string };
  hardware: { threads?: number; memoryGiB?: number };
  webgl?: WebGlInfo;
  features: Record<string, boolean>;
}

export interface WebGlInfo {
  version: string;
  shadingLanguage: string;
  vendor: string;
  renderer: string;
  /** The GPU as the driver names it (WEBGL_debug_renderer_info), where the browser tells. */
  gpuVendor?: string;
  gpu?: string;
  antialias: boolean;
  drawingBuffer: { width: number; height: number };
  limits: Record<string, number | number[]>;
  precision: string;
  extensions: string[];
}

const media = (q: string) => typeof matchMedia === 'function' && matchMedia(q).matches;

/** The browser, its engine and version, and the OS, from a user agent string. */
export function browserOf(ua: string): { name: string; version: string; engine: string; os: string;
  mobile: boolean } {
  const v = (re: RegExp) => ua.match(re)?.[1] ?? '';
  // (Order matters: Edge, Opera and Samsung say Chrome too; Chrome says Safari; iOS browsers are all WebKit.)
  const [name, version] = /Edg(?:e|A|iOS)?\//.test(ua) ? ['Edge', v(/Edg(?:e|A|iOS)?\/([\d.]+)/)]
    : /OPR\//.test(ua) ? ['Opera', v(/OPR\/([\d.]+)/)]
      : /SamsungBrowser\//.test(ua) ? ['Samsung Internet', v(/SamsungBrowser\/([\d.]+)/)]
        : /Firefox\/|FxiOS\//.test(ua) ? ['Firefox', v(/(?:Firefox|FxiOS)\/([\d.]+)/)]
          : /Chrome\/|CriOS\//.test(ua) ? ['Chrome', v(/(?:Chrome|CriOS)\/([\d.]+)/)]
            : /Safari\//.test(ua) ? ['Safari', v(/Version\/([\d.]+)/)] : ['unknown', ''];
  const ios = /iPhone|iPad|iPod/.test(ua);
  const engine = ios || (name === 'Safari') ? 'WebKit' : name === 'Firefox' ? 'Gecko'
    : /Chrome\//.test(ua) ? 'Blink' : 'unknown';
  const os = ios ? `iOS ${v(/OS ([\d_]+)/).replace(/_/g, '.')}`.trim()
    : /Android/.test(ua) ? `Android ${v(/Android ([\d.]+)/)}`.trim()
      : /Windows NT/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS'
        : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown';
  return { name, version, engine, os, mobile: /Mobi|iPhone|Android.*Mobile/.test(ua) };
}

/** WebGL's version, GPU and limits, from the renderer's context. */
function webglOf(renderer: THREE.WebGLRenderer): WebGlInfo | undefined {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  if (!gl) return undefined;
  const p = (k: number) => gl.getParameter(k) as unknown;
  const num = (k: number) => {
    const x = p(k);
    return x && typeof x === 'object' && 'length' in (x as object) ? Array.from(x as ArrayLike<number>) : Number(x);
  };
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const two = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const limits: Record<string, number | number[]> = {
    maxTextureSize: num(gl.MAX_TEXTURE_SIZE), maxCubeMapSize: num(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
    maxRenderbufferSize: num(gl.MAX_RENDERBUFFER_SIZE), maxViewportDims: num(gl.MAX_VIEWPORT_DIMS),
    maxVertexAttribs: num(gl.MAX_VERTEX_ATTRIBS), maxVertexUniformVectors: num(gl.MAX_VERTEX_UNIFORM_VECTORS),
    maxFragmentUniformVectors: num(gl.MAX_FRAGMENT_UNIFORM_VECTORS), maxVaryingVectors: num(gl.MAX_VARYING_VECTORS),
    maxTextureImageUnits: num(gl.MAX_TEXTURE_IMAGE_UNITS),
    maxCombinedTextureImageUnits: num(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
    aliasedLineWidthRange: num(gl.ALIASED_LINE_WIDTH_RANGE), aliasedPointSizeRange: num(gl.ALIASED_POINT_SIZE_RANGE),
    ...(two ? { maxSamples: num(gl.MAX_SAMPLES), max3dTextureSize: num(gl.MAX_3D_TEXTURE_SIZE),
      maxDrawBuffers: num(gl.MAX_DRAW_BUFFERS), maxElementIndex: num(gl.MAX_ELEMENT_INDEX) } : {}),
  };
  return {
    version: String(p(gl.VERSION)), shadingLanguage: String(p(gl.SHADING_LANGUAGE_VERSION)),
    vendor: String(p(gl.VENDOR)), renderer: String(p(gl.RENDERER)),
    ...(debug ? { gpuVendor: String(p(debug.UNMASKED_VENDOR_WEBGL)), gpu: String(p(debug.UNMASKED_RENDERER_WEBGL)) }
      : {}),
    antialias: !!gl.getContextAttributes()?.antialias,
    drawingBuffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight },
    limits, precision: renderer.capabilities.precision,
    extensions: [...gl.getSupportedExtensions() ?? []].sort(),
  };
}

/** This client's details now: `renderer` the view's (its WebGL), `inUse` the device class the viewer uses. */
export function clientInfo(renderer?: THREE.WebGLRenderer, inUse?: DeviceClass): ClientInfo {
  const signals = deviceSignals();
  const chosen = deviceOverride();
  const nav = navigator as Navigator & { deviceMemory?: number };
  const gamut = ['rec2020', 'p3', 'srgb'].find((g) => media(`(color-gamut: ${g})`)) ?? 'unknown';
  return {
    viewer: { version: VERSION || 'dev' },
    device: { detected: classifyDevice(signals), ...(chosen ? { chosen } : {}), ...(inUse ? { inUse } : {}) },
    browser: { ...browserOf(navigator.userAgent), userAgent: navigator.userAgent },
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth,
      availHeight: screen.availHeight, pixelRatio: devicePixelRatio, colorDepth: screen.colorDepth,
      ...(screen.orientation?.type ? { orientation: screen.orientation.type } : {}) },
    window: { width: innerWidth, height: innerHeight },
    input: { pointer: media('(pointer: fine)') ? 'fine' : media('(pointer: coarse)') ? 'coarse' : 'none',
      anyFinePointer: media('(any-pointer: fine)'), hover: media('(hover: hover)'),
      maxTouchPoints: navigator.maxTouchPoints || 0 },
    display: { colorScheme: media('(prefers-color-scheme: dark)') ? 'dark' : 'light',
      reducedMotion: media('(prefers-reduced-motion: reduce)'), colorGamut: gamut,
      dynamicRange: media('(dynamic-range: high)') ? 'high' : 'standard' },
    hardware: { ...(navigator.hardwareConcurrency ? { threads: navigator.hardwareConcurrency } : {}),
      ...(nav.deviceMemory ? { memoryGiB: nav.deviceMemory } : {}) },
    ...(renderer ? { webgl: webglOf(renderer) } : {}),
    features: {
      webAssembly: typeof WebAssembly === 'object', sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
      crossOriginIsolated: !!globalThis.crossOriginIsolated, secureContext: !!globalThis.isSecureContext,
      webCrypto: !!globalThis.crypto?.subtle, offscreenCanvas: typeof OffscreenCanvas === 'function',
      serviceWorker: 'serviceWorker' in navigator, serviceWorkerControlled: !!navigator.serviceWorker?.controller,
      indexedDB: typeof indexedDB === 'object', fileSystemAccess: 'showSaveFilePicker' in globalThis,
      clipboard: !!navigator.clipboard?.writeText,
    },
  };
}

/** The details as text: one `key: value` line each, nested keys dotted, numbers' arrays joined, strings' one a line. */
export function clientText(info: ClientInfo): string {
  const lines: string[] = [];
  const walk = (o: unknown, path: string) => {
    if (Array.isArray(o) && o.every((x) => typeof x === 'string')) {
      lines.push(`${path}: (${o.length})`, ...o.map((x) => `  ${x}`));
    } else if (Array.isArray(o)) lines.push(`${path}: ${o.join(', ')}`);
    else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
    } else lines.push(`${path}: ${String(o)}`);
  };
  walk(info, '');
  return lines.join('\n');
}

/** Shows the details as text to copy (About's Client details), with Copy and Close. */
export function showClientInfo(info: ClientInfo): Promise<unknown> {
  const text = clientText(info);
  const area = Object.assign(document.createElement('textarea'), { value: text, readOnly: true, rows: 20,
    spellcheck: false, className: 'client-info' });
  return showDialog({ title: 'Client details', closeButton: true,
    body: ['This browser, device and GPU as the viewer sees them (recordings carry the same; nothing that ' +
      'identifies you).'], content: area,
    buttons: [{ label: 'Close', value: 'close', primary: true }, { label: 'Copy', value: 'copy', action: (b) => {
      const done = () => { b.textContent = 'Copied'; };
      // (The clipboard API needs a secure context; else the old way, from the selected text.)
      const old = () => {
        area.focus();
        area.select();
        if (document.execCommand('copy')) done();
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, old);
      else old();
    } }] });
}
