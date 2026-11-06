# Viewer notes

Notes for work on `packages/viewer`: its design rules, how its parts fit, and the quirks of its libraries. The README's "Viewer" section is the user guide. The full record (every decision with its alternatives, measurements, and planted-bug counts) is in `git show V0.2.0:CLAUDE.md` under "The viewer"; the original proposal in `workdir/2026-10-24_viewer/proposal.md`.

## The viewer

- Purpose: debugging, prototyping and inspecting models, not end users; minimal, on three.js and its ecosystem (lil-gui), no frameworks. Chrome first on desktop and Android; iOS best effort. Mouse first, touch friendly; the tree compact.
- Build: Vite 8 (pinned), `vite-plugin-pwa` 2.0.0 in builds only (`autoUpdate`, everything precached, up to 32 MiB a file; `/content/` never answered by the app shell). Neither type-checks: `npm run typecheck` is the check. Builds stub `node:fs`, `node:fs/promises`, `node:path` (`no-node.ts`) and drop `with { type: 'json' }` from dynamic imports. `dist/licenses.md` is ours: Vite's list plus the import worker's npm packages and the WebAssembly modules (Vite's `build.license` misses them).
- The version: the root `package.json`'s, plus the commit's 7 hex digits in builds (`-dirty` with uncommitted changes) (`__CAD_IO_VERSION__`, `version.ts`); the controls' title `cad-io-js <version>` and About.
- Dev server (`cad-viewer start|stop|status|open`, port 5180, state in `packages/viewer/.run/`): a content root (default `test_corpus/`) at `/content/`; `--host` LAN mode, plain http by default (not a secure context: no service worker, no File System Access, no `crypto.subtle`), self-signed or mkcert certificates by option.
- Deploy: `scripts/deploy-viewer.sh` builds with this machine's modules and force-pushes `gh-pages` (with `.nojekyll`, and the demo models from `test_corpus/demo/`, CC BY-SA 4.0); refuses uncommitted changes and unpushed commits.
- `?model=` loads at startup (relative: within the content root, `content/` beside the page; `/...`: the page's server; a scheme: a URL); `?url=` is the same for older links. Content paths are plain paths with each segment URL-encoded; `.`, `..` and empty segments refused. Names reach the page only as text.

## Loading

- One path for every format: the library's importers in the import worker (`model-load.ts`'s `importModel`, `loadModelIn`; `import-worker.ts`), the scene posted with its source levels' buffers transferred, B-rep parts meshed by the pool (nested workers) through the IndexedDB cache. A new file or Clear cache disposes the pool. The page copies a file's bytes before transferring them (kept for Save original and Mesh again).
- Events: `importing` (STEP's phases, at most every 200 ms), the scene (without payload functions), mesh events (with the part's measures), `edges` events, the end (with the rebuilt sphere and `meshing`).
- Edges: B-rep edges where the part has them; else found in the worker (`edges.ts`'s `findEdges`, a port of three.js's `EdgesGeometry`, 10 degrees, on a 1 um world grid in each part's units by its first placement's scale), part by part after the scene, yielding between parts.
- The page adds the scene's meshes in 30 ms slices (`SLICE_MS`) with the status counting; face areas are computed only where measures judge them or Details asks; the clipping sphere grows from mesh boxes. Rule (the user): no task over 500 ms on the page; split it or move it to a worker.
- `SceneGraph.addMesh` replaces a part's mesh; a source level shows at once and stays if meshing fails.
- Zoom while loading (`load-fit.ts`'s `LoadFit`): fit the scene's estimated sphere before any mesh, then at most once a second, only ever out, until the user moves the view; at the end once more on the grown sphere; a shrunk final sphere is used by the next zoom all. A new model's camera starts iso about the origin; Mesh again (`keep`) keeps the view.
- Mesh again keeps the camera, planes, overrides (all slots, by path, a part's detail's by segment before its mesh), selection, the tree's expansion and scroll (as the top row's path plus pixels); what never resolves is counted in the status line (`; 2 appearance overrides and 1 selected not found again`), paths in the console.
- The problems dialog lists a load's warnings and errors (errors first, at most 500 rows, Copy IDs); not in plain `?check` pages unless `?check=dialogs`. Opening errors get an error dialog too.
- Devices (`device.ts`'s `classifyDevice`, by screen size in CSS pixels, primary pointer, touch points, user agent; fine pointer and no touch first): phones and tablets mesh coarse with at most 3 workers, desktops medium; B-Rep Meshing's **Device** overrides it (remembered).

## Export

- **Save original...** saves the bytes as read (`showSaveFilePicker` where available, else a download link); a `.gltf` without its `.bin`.
- **Export...** (`export-dialog.ts`, `export-formats.ts` imports no exporter): `stepconv`'s options per format plus **Apply the viewer's hiding and opacity** (`export-shown.ts`: per-placement instance overrides; a face hidden in a shown placement and triangle edges can't be written). Ask for the save target first, while the click still counts as a user gesture.
- The worker handed its meshes to the page, so the page lends them back (transferred) for the export and takes them back after (`takeBack`, also on errors), the page blocked meanwhile (`showBusy`); every three.js attribute holding an old array is updated.
- The worker beats every second during an export; 60 s without one (`EXPORT_SILENCE_MS`) or an answer without the meshes means it's lost: terminated, `WorkerLost`, and the model loaded again as Mesh again does. The exporters run in steps (`cad-scene`'s `steps.ts`: `drain`, `paced`, a pause every 50 ms) so beats can come; Draco's own encoding can't pause (LMP1: 6.8 s). Running out of JavaScript heap stalls the whole tab, so a heartbeat is the only signal.

## Rendering

- `EffectComposer` with N8AO's pass then SMAA (without AO, `RenderPass` and `OutputPass`); no MSAA; a stencil buffer (caps). Drawn only on change, at most 30 fps. Orthographic camera; near and far set each frame around a sphere of everything drawn (`clipTo`; the sphere grows as meshes arrive and must hold failed parts' outlines).
- Phong for everything (specular grey 0.4, ambient 1, a headlight 2.5 over the viewer's shoulder), adjustable; transparency by three.js's per-object sorting; N8AO detects transparency only on single materials, so the viewer tells it (`Composer.setTransparent`) when materials change.
- Edges: fat (`fat-edges.ts`: Wireframe per edge object following its placement, visibility and material each frame) by default on desktops, thin WebGL lines on phones and tablets; the thin ones stay on their layer for picking. SwiftShader draws fat edges 20 x slower, so browser-check pages ask for thin unless a check wants fat.
- Failed faces' red outlines are pushed toward the camera in their vertex shader (`depth-bias.ts`: the larger of 8 pixels and 2 linear deflections), since polygon offset moves only triangles. Partly failed rows are red in the tree too.
- Triangle edges (`triangle-edges.ts`): Off, Selected, All, or per node by override; a wireframe per drawn mesh sharing its geometry, in a group outside the model.
- Themes (`theme.ts`): Auto, Light, Dark; CSS variables on the root; applied before first paint by an inline script in `index.html`; a custom background. Not in links or recordings.
- Colours: STEP sRGB; glTF linear except Onshape's (see `scene-formats.md`); three.js JSON sRGB hex.

## Sections

- Up to three planes, one per world axis (the renderer's global clipping planes). Caps by the stencil technique per placed closed part and plane: the counting passes are our own `ShaderMaterial` clipped by their own plane only (else another plane's cut hides a cap), the cap quad clipped by all; a cap a hair inside the kept side.
- What's capped: a part the file says is closed (`Part.closed`, whatever gaps its mesh has); unknown: the triangles decide (`closure.ts`: welded by position, every edge used twice, gaps under 0.1 % of the mesh's size tolerated, over 4,000 boundary edges open), over all of a part's meshes together (Onshape GLBs have a mesh per face).
- Hatching fixed on the model: lines 1/60 of the model's radius apart times 5/8, 6.5/8 or 1, at one of 6 angles by a hash of the scene part; width in CSS pixels by screen derivatives (cadrender's profile; **Hatch width**); styles Part colours (default) and Drawing (cadrender's beiges); everything per cap is a uniform (three.js shares programs across materials whose `onBeforeCompile` match).
- Picks hit caps (`Sections.capHits`): a ray crossing into the kept side inside a capped part's solid (parity of crossings; hits at one point facing the same way count once).

## Camera and input

- `TrackballControls` without inertia, with our own pan (`Viewer.panBy`: 1:1 with the pointer, applied as a projection shift, the target untouched) and zoom (`zoomAt` about the cursor's line of sight). The orbit centre moves to the nearest drawn hit under the cursor when a zoom gesture begins (wheel after 300 ms idle, a middle press, a second finger), and to the point picked on every pick that hits (`orbitAbout`); over nothing it stays. Chrome's pinch is ctrl-wheel (e^(pixels/100), at most e^0.3 a frame); Safari's is `gesturechange` (`scale`, 1:1). Confirmed excellent by the user on Mac, iPad, Android and iPhone.
- Fits use spheres (the same framing from every direction): zoom all on `Scene.bounds`, zoom selected on the selection's mesh boxes by `boxesSphere`; 5 % margin; the free width left of the controls (`setCovered`, `setViewOffset`; ignored when they'd leave less than half the view); `fitSphere` takes the view's aspect and the fitting aspect apart.
- Flights: zoom all, zoom selected and the views fly for about a second (smoothstep, `interpolateCamera`); views only turn about the orbit centre; input or an exact camera stops a flight; zooming while loading is instant. Browser-check pages set `flightMs` 0.
- Views: front looks along +Y with Z up, top has +Y up, `iso` from +X -Y +Z.

## Picking and selection

- A pick is a press and release within 5 pixels and 600 ms; brute-force raycasting (no `three-mesh-bvh`). The ray starts at the near plane (the camera can be inside the drawn sphere). Lines and points are tested by our code in the world (`pick.ts`), within 4 pixels, winning over the face only when they're the face's own part's and within twice that.
- Levels: assembly, part, face/edge/curve (which turns the tree's detail on). Highlight by tinted material copies (emissive orange), a selected face by an overlay; other instances light blue.
- Select all, Invert selection, Select parent, Select by ID... (`step-ids.ts`'s `parseIds`; a node's ids: an assembly's occurrence's then component's sources, a placed part's NAUO, product, representation; a face's own); every selection made outside the tree reveals all its nodes there.
- Each frame's refresh re-highlights when the selection's objects changed (arriving meshes come in new objects).

## The tree and appearance overrides

- Headless Tree (`@headless-tree/core` 1.x) for state, our own rows (only those in view), behind `tree-view.ts`'s interface with one adapter file (`headless-tree-view.ts`), so it can be replaced. Rows as wide as the widest drawn (scroll sideways). The panel's width dragged by a handle (`side-handle.ts`, remembered; 140 px default on narrow screens, a wide grip on touch screens).
- The tree's top nodes are the file's own roots (one or several), with no node for the file, so paths start with a root's name (the user, 2026-11-06; alternatives: a file node only when there are several roots; old paths kept readable by a fallback, rejected). Node paths: occurrence names (`%`, `/`, `:` escaped) with `:k` from the second same-named sibling, `face#<STEP id>`, `edges`, `curves`, `points`; a placed part's path ends with its own segment.
- `AppearanceOverride { hidden?, transparent?, alpha?, triangleEdges? }` per node (`model.ts`), each slot inherited by everything below that doesn't set it (nearest wins). Buttons act on `NodeModel.cover` of the selection (a node instead of all its children) and set the slot there without clearing it below; a node's own slot is cleared where it would inherit that value. `transparent: false` is the file's own opacity. Faces' overrides are per placement. The file's hidden placements start as `hidden: true` overrides. Hide others / Show others act on `others(selection)`.
- Every reader goes through the resolved looks (`NodeModel.look`, `applyPart`; the scene graph's `setLook`, `triangle-edges.ts`, `export-shown.ts`); a group is hidden only when nothing under it is shown.
- The tree's context menu (right-click, or a 550 ms long press, as iOS sends no `contextmenu`) has **Override Appearance...** (`appearance-dialog.ts`): a floating, non-modal panel, one at a time, every change taking effect at once and recorded once made; an eye after the name of nodes with an override.
- Dialogs (`dialog.ts`) are native `<dialog>`s, draggable by their title.

## Driving it from outside

- `window.cadViewer` (`automation.ts`, version 5, changed only by additions within a version): `state()`, `apply()`, `open()`, `view()`, `zoomAll()`, `pickAt()`, `screenshot()`, `nodes()`, `idle()` (waits for loads however begun, the last wanted frame, flights and the tree's refresh), `record`/`recording`/`replay`.
- Links: Copy link writes `?model=...#<view>` (servers refuse long queries: GitHub Pages 414 past about 8,100 characters); the page reads the view from the fragment and the query. View parameters: `view`, `camera` (12 numbers; 10 read), `cut`, rendering settings that differ from defaults, `hide`, `show`, `alpha=<a>:<path>` (or `default:`), `tri=on|off:<path>`, `select`. Page options stay in the query: `deterministic` (pixel ratio 1), `controls=0`, `check`, `record`.
- `cad-viewer shot` (headless Chrome, `server/headless.ts`, shared with the browser check; `controls=0`, `--theme`, `--background`) and `cad-viewer replay` (window as recorded, files found under the content root by name and size, exit 3 on divergences).
- Recordings (`recorder.ts`): events timed from the start; pointer events on the view in CSS pixels (moves only while pressed), picks with their result, control changes named by folder path, the camera at the end of each drag, calls through `cadViewer`, a snapshot (`state`, including `meshing` and the model's `meshedWith`), local files by name, size and SHA-256 only. Replay is semantic: controls set, picks clicked at their pixel, cameras set; File's controls and the like aren't replayed; divergences reported; steps counted (`replay-report.ts`'s `isStep`). In the page it replays in real time (each event after the last finishes, gaps capped at 3 s, drags interpolated, controls flashed). A file with another hash is never loaded. Recordings name controls by folder, so renamed folders replay as gone.

## The browser check

- Drives headless Chrome over the DevTools protocol (`--virtual-time-budget` doesn't wait for Web Workers); SwiftShader for WebGL (`--use-angle=swiftshader --enable-unsafe-swiftshader`); `?check` puts a report in the body's `data-report`; `BUILD=1` checks a build served at `/viewer/` by a plain static server. `two planes` sometimes fails in a full run on a build and passes alone.
- Picking is checked against an independent oracle (an ID render, each part a flat colour, against `pickAt` on a grid) on several models, including one in metres.
- Reading pixels back (`gl.readPixels` after `composer.render()`) is reliable only after a few real animation frames since the scene changed; wait three and render twice.
- Headless Chrome takes the system's colour scheme: don't expect one theme's exact colours.

## Libraries and the browser

- **`localhost`** resolves to `::1` or `127.0.0.1` first, and the order changes; Vite binds the first, so readiness probes try both.
- **Vite** (8.3): its dev server serves a JSON module as JavaScript, so `import(..., { with: { type: 'json' } })` fails; it only bundles a worker written as `new Worker(new URL('./w.ts', import.meta.url), ...)` in one expression, and can't bundle `import(url)` of a run-time URL (hence the viewer's own worker entry). Its `build.license` lists only npm packages under `node_modules`, written after every plugin's `generateBundle` (add to it in `writeBundle`).
- **three.js 0.186 raycasting of lines and points** divides the threshold by the object's own scale only, while the bounding-sphere cull works in the world: under a part scaled from metres the reach was 1000 x too wide. Hence our own line and point tests.
- three.js's `Raycaster.setFromCamera` starts an orthographic ray at the camera, missing what's between the near plane and the camera.
- **Headless Tree** (1.7): set `expandedItems` and rebuild once rather than `expandAll` (quadratic); its container props set the element's position (wrap the scroller); a plain click toggles a folder unless a custom feature undoes it; `rebuildTree()` after creating; `getItemName` gives ARIA labels, so it must be the name.
- **N8AO** (2.0.1): no types (`src/n8ao.d.ts`); its class names are mangled in builds, so checks recognize passes by identity.
- **Service workers:** `navigator.serviceWorker.ready` never settles when none registers: bound every wait on it.
- `node:test`'s `mock.property` on Node's getter for `globalThis.crypto` hangs the test; replace the property by hand.
- Kill headless Chrome and wait for it to exit before deleting its profile.

## Not tested

Firefox and Safari beyond the user's own tries (the checks run in headless Chrome); real phones and tablets beyond the user's tries (only Chrome's emulation in checks); the full-screen scroll fix on a phone.
