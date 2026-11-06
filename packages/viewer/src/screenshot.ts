// Screenshots (File's Screenshot...): the model alone, or the whole window with its controls, as PNG or JPEG, at a
// width in CSS pixels (the height in proportion). The model alone is the 3D view cropped to the on-screen box of the
// model's sphere, where that's visible between the tree panel and the controls. The whole window is redrawn from the
// page's elements by modern-screenshot, or taken from the browser's tab capture (getDisplayMedia) where it has one.
//
// A WebGL canvas reads back blank once its frame has been presented (no preserveDrawingBuffer), so the view is drawn
// and copied in one task (Viewer.snapshot, Viewer.drawView); modern-screenshot is async, so for it the view is laid
// over the canvas as an image first. modern-screenshot is imported only when used (a chunk of its own; Node's tests
// import this module for its geometry).

/** A rectangle in CSS pixels of the window. */
export interface Rect { left: number; top: number; width: number; height: number }

/** A circle in CSS pixels of the window: a sphere as the camera shows it. */
export interface Circle { x: number; y: number; r: number }

/** What can be seen of the model's view: the view right of the tree panel (if any) and left of the controls. */
export function freeArea(view: Rect, tree?: Rect, controls?: Rect): Rect {
  let left = view.left, right = view.left + view.width;
  if (tree && tree.width > 0) left = Math.max(left, tree.left + tree.width);
  // (Controls that leave nothing beside them, as on a phone, are ignored.)
  if (controls && controls.width > 0 && controls.left > left) right = Math.min(right, controls.left);
  return { left, top: view.top, width: Math.max(0, right - left), height: view.height };
}

/** The model's on-screen box: its circle's square, within what can be seen; undefined if none of it can. */
export function modelRect(circle: Circle, free: Rect): Rect | undefined {
  const left = Math.max(free.left, circle.x - circle.r), right = Math.min(free.left + free.width, circle.x + circle.r);
  const top = Math.max(free.top, circle.y - circle.r), bottom = Math.min(free.top + free.height, circle.y + circle.r);
  if (!(right - left >= 1 && bottom - top >= 1)) return undefined;
  return { left, top, width: right - left, height: bottom - top };
}

/** A box's whole pixels (what's captured: the output's default width and its height). */
export function snapped(r: Rect): Rect {
  const left = Math.round(r.left), top = Math.round(r.top);
  return { left, top, width: Math.max(1, Math.round(r.left + r.width) - left),
    height: Math.max(1, Math.round(r.top + r.height) - top) };
}

/** The height of an image `width` wide, in proportion to a box. */
export function heightFor(width: number, box: { width: number; height: number }): number {
  return Math.max(1, Math.round(width * box.height / box.width));
}

/** A canvas `width` pixels wide of `source`'s part `crop` (in the source's own pixels), scaled smoothly. */
export function scaledCanvas(source: CanvasImageSource, crop: Rect, width: number): HTMLCanvasElement {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(width));
  out.height = heightFor(out.width, crop);
  const g = out.getContext('2d')!;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, crop.left, crop.top, crop.width, crop.height, 0, 0, out.width, out.height);
  return out;
}

/**
 * The view's pixels with a transparent background, from the same view drawn on black and on white (difference
 * matting): the renderer's canvas is opaque and its post-processing doesn't carry alpha, but every pass blends with
 * the background alike, so where a pixel is a coverage a of colour F, on black it's a F and on white a F + (1 - a).
 * In sRGB values, not linear: the antialiasing (SMAA) runs after the output's sRGB encoding, and image viewers
 * composite in sRGB too, so the image over the view's background is the view again (exactly over black or white,
 * transparent parts included, whose blending happens before the encoding), but for a few pixels of the outline, where
 * SMAA's edge detection itself depends on the background. Both arrays are RGBA of the same size; the result is RGBA
 * with straight (not premultiplied) alpha.
 */
export function matte(onBlack: Uint8ClampedArray, onWhite: Uint8ClampedArray): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(onBlack.length);
  for (let i = 0; i < onBlack.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 3; k++) d += onWhite[i + k]! - onBlack[i + k]!;
    const a = Math.min(255, Math.max(0, 255 - d / 3));
    for (let k = 0; k < 3; k++) out[i + k] = a > 0 ? Math.round(255 * onBlack[i + k]! / a) : 0;
    out[i + 3] = Math.round(a);
  }
  return out;
}

export type ImageFormat = 'png' | 'jpeg';

/** A canvas's image as bytes; JPEG on the view's own background (it has no alpha). */
export function encode(canvas: HTMLCanvasElement, format: ImageFormat, background: string): Promise<Blob> {
  let c = canvas;
  if (format === 'jpeg') {
    c = document.createElement('canvas');
    c.width = canvas.width;
    c.height = canvas.height;
    const g = c.getContext('2d')!;
    g.fillStyle = background;
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(canvas, 0, 0);
  }
  return new Promise((resolve, reject) => c.toBlob((b) => b ? resolve(b) : reject(new Error('the image could not be '
    + 'encoded')), format === 'png' ? 'image/png' : 'image/jpeg', 0.92));
}

/**
 * The whole window redrawn from its elements, `width` pixels wide. `view` gives the 3D view as an image (drawn and
 * read in one task), laid over its canvas while the page is drawn, under what's drawn over the view (the details box,
 * the status line: being positioned, it would hide those that come before it); dialogs are left out.
 */
export async function redrawWindow(canvas: HTMLCanvasElement, view: () => string, width: number):
  Promise<HTMLCanvasElement> {
  const r = canvas.getBoundingClientRect();
  const img = document.createElement('img');
  img.src = view();
  Object.assign(img.style, { position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`,
    height: `${r.height}px`, pointerEvents: 'none', zIndex: '0' });
  canvas.parentElement!.prepend(img);
  try {
    await img.decode();
    const { domToCanvas } = await import('modern-screenshot');
    const w = window.innerWidth, h = window.innerHeight;
    return await domToCanvas(document.body, { width: w, height: h, scale: width / w,
      filter: (n) => n !== canvas && !(n instanceof HTMLDialogElement) });
  } finally {
    img.remove();
  }
}

/** Whether the browser can capture its tab (getDisplayMedia): desktop browsers, not phones and tablets. */
export function canCaptureTab(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
}

/**
 * One frame of the browser's capture of this tab (the browser asks first; it may offer other tabs or windows, and
 * then that's what's taken), `width` pixels wide. Rejects if the user refuses.
 */
export async function captureTab(width: number): Promise<HTMLCanvasElement> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false,
    preferCurrentTab: true, selfBrowserSurface: 'include' } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    // (A couple of frames, so the frame is of the page as it is, not as the capture began.)
    for (let k = 0; k < 2; k++) await new Promise((r) => requestAnimationFrame(r));
    return scaledCanvas(video, { left: 0, top: 0, width: video.videoWidth, height: video.videoHeight }, width);
  } finally {
    for (const t of stream.getTracks()) t.stop();
  }
}
