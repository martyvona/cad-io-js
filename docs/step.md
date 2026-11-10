# STEP import notes

Notes for work on `step-parser`, `step-schemas`, `step-import` and STEP files: the importer's rules, the corpus's examples, and the STEP backlog. STEP itself, and what real files do in general, is in `step_tutorial.md`. The full record (alternatives, corpus counts, checks) is in `git show V0.2.0:CLAUDE.md` and `git show V0.1.0:CLAUDE.md`.

## The importer's rules

- Raw JSON favours clarity over size; numbers are lexical (as written), since context can't type every number and loading would need the schema.
- References beyond 2^32 - 1 read as `$` with a warning, as OCCT does. Dangling references are warned of per part.
- Binding (`step-parser`'s `bind.ts`) leaves an instance whose records don't match the schema's attribute counts unbound, with one exception: a complex instance's `REPRESENTATION_ITEM()` without its name is bound with the name `''`, as OCCT reads it (its test `bugs/step/bug29478`: `bug29478.stp`'s only face is on such a B-spline surface). Its warning is in `BoundInstance.repairs`, which a `Reader` reports (so the importer, as the part's `B-rep model:` diagnostics); `OpenOptions.missingNames: false` leaves such instances unbound. The corpus's other mismatches (`bind_corpus.log`: `DOCUMENT_FILE`, `DESCRIPTIVE_REPRESENTATION_ITEM`, `POSITION_TOLERANCE`) are outside the geometry and stay unbound.
- Placements: OCCT's rule for swapped representations and items, except Alibre (items kept as written when `originating_system` contains 'Alibre'). Placements among a representation's items that nothing uses are coordinate systems, not transforms (unlike OCCT).
- Styles: faces show a boundary colour (`SURFACE_STYLE_BOUNDARY`) when nothing more specific colours them; the most specific style wins over a representation's plain style. A part is hidden when every item it draws is invisible, placements among its items (as assemblies' placements refer to, and our exporter writes) aside.
- Names: generic part names (blank, `NONE`, `#digits`) take the first placing product's; blank product names give way to the part number.
- A part's origin is the centre of its `VERTEX_POINT`s' box, or of all its points when it has none (`bug24383_224013.stp` has control points 30 km off a 32 mm part: all points made its float32 positions step by 1.8 mm). `Brep.vertexBox` is that box, used for the model's sphere before meshing.
- `Part.closed`: true when every face is in a `CLOSED_SHELL`, false when one is in an `OPEN_SHELL` (or another face set), absent when the file doesn't say (geometric sets, loose faces, tessellated faces without a shell link).
- `Scene.sourceUnit`: the first root product's main shape representation's length unit, else its first part's.
- Leaf products (a component whose only content is one part reference) become part references in their parent (`leafParts`, see `scene-formats.md`); a placed part's STEP ids are its NAUO's, its product's, then its shape representation's.
- `importStep`'s `onProgress` reports `reading`, `structure`, `parts` (`done` of `total` representations), `assembly`.
- Each B-rep part's parsed model (`brep.ts`, `Part.brep.model`; `brep-model.md` for its rules) is built through a `Reader` of its own per part (the shared one's cache of bound instances would keep every part's geometry alive); its diagnostics are the part's, prefixed `B-rep model:`, repeated ones said once with a count. Nothing the scene keeps refers to the file.
- A torus with a negative major radius (`bug25287_bad_tess_face_plus.step`, `bug30014.stp`, `bug32239.STEP`) is read with the radius' absolute value and its faces turned over, as OCCT reads it (its bug 26376: SolidWorks and Pro/E write such faces so): the same points come from (u + pi, pi - v), a reflection, so Part 42's normal points the other way. P-curves on such a torus aren't read (they would need that remapping; the corpus has none). Kept as the absolute value, the faces were the rest of the torus (85,598 mm^2 for 14.5).
- Failed faces' outlines (`Brep.outline`) come from the model (`cad-brep`'s `faceOutlines`), whatever the backend.

## AP242 tessellated geometry read by step-import

`tessellated.ts` (`tessellatedItems`, `readTessellated`, `moveMesh`); always read (the option to leave it to the backend went with the subset: `brep-model.md`, decision 10).

- A representation counts as tessellated when every item but placements, mapped items and annotations is a `TESSELLATED_ITEM`; it's read only if every item it reaches is one the reader takes, else it goes to the backend with a note naming the first other (`CUBIC_BEZIER_TRIANGULATED_FACE`).
- Read: solids, shells, faces (strips and fans in Part 42's order), triangulated surface sets (a face each), tessellated curve sets, wires, edges, point sets, geometric sets with repositioned items. Graphical PMI stays out.
- Such parts get a level `from: 'source'` and no `brep`, so no backend is asked.
- A product with a B-rep and a tessellation of it is one part with both (pairing by the tessellation's links, else the product's one B-rep part with faces; the level moved into the B-rep's coordinates), the source level shown at once and replaced when meshed.
- Edges: the file's `TESSELLATED_EDGE`s where present, else face boundaries, `shared` or `free`. Normals: the file's where given, else smooth within each face. Triangles with a repeated corner skipped; bad indices skipped with a warning; a shell's `topological_link` decides `closed`.
- The corpus has tessellated part geometry in 5 files only (`bug33638.stp`, `bug33410.step`, `bug33100_window.step`, NIST FTC 08 `-tg` twice); the rest is graphical PMI. Our triangles meet OCCT's exactly, wound the other way (OCCT reverses strips and fans: `step_tutorial.md`, `backends.md`).

## Real files: the corpus's examples

What STEP files do in general, and how real files depart from the standard, is in `step_tutorial.md`. Here, what the importer does about it and where the corpus shows it.

- **Lexical:** `bug25171.stp`'s `'l'bracket-assembly'` (an apostrophe ends a string only before `,` or `)`); OCCT's test `bugs/step/bug28454_2` has 15 escape cases (its printed comment for case 13 is a typo); `bug32314_corrupted.stp` has an unbalanced quote (we resynchronize at `\n#<digits>=`); `bug31292.stp` has references beyond 2^32 - 1 (read as `$`). Raw non-ASCII decodes as UTF-8 when valid, else ISO 8859-1.
- **Schemas:** unknown entity names fall back to AP242; values in derived slots (`NAMED_UNIT(#568)` beside `CONVERSION_BASED_UNIT`) and `*` in explicit ones, partials out of order, reals in INTEGER slots, `$` in mandatory attributes: bound by position with a diagnostic, never a failure. The AP242 dictionary (stepcode's, WG12 N11521) declares 2,407 entities, though its header claims 2,404.
- **Placements:** swapped representations are inverted and swapped items swapped back (as OCCT), except Alibre (`trj4_s1-ai-214.stp`), whose files assemble only read as written. `2.stp` maps products into others with no NAUO (we make occurrences, as OCCT's XCAF does); `bug25167.stp` has `relating_product_definition` pointing at a `PRODUCT_DEFINITION_SHAPE`. OCCT's formula (`M1^-1 * M2`) agrees with the definition only when one frame is the identity, which is every corpus assembly but `OCC22238_test.stp`; a left-handed y axis passes every relative transform test, so the tests check one placement absolutely.
- **Units:** `trj7_k1-id-214` mixes cm and inch; `trj2_as1-pe-203.stp` declares an 'INCH' area unit (read as squared).
- **Styles:** `bug31670_russian.stp` styles a representation and its faces plainly in different colours (the face wins); Unigraphics files colour solids only by `SURFACE_STYLE_BOUNDARY` (shown on faces). A part gets one material only when every face resolves to one colour, else per-face materials.
- **Names:** generic names (`NONE`, `#609`, blank) give way to the product's; `SOLID` and `SHELL` are kept.
- **Orientation:** surface models facing inward: the K1 key in the `trj*_k1*` files, `bug28366_fuselage.stp` (`tessellateScene` turns them over). Voids reversed twice: the 1998 ProSTEP round 8 BV1 blocks. Real voids: `bug24055_8MTF-75LS05.step`. `bug29979_firetherm_12.step` part 19 has two positive pieces inside its body: undecidable, left alone.
- **Open meshes are open shells:** nearly all open OCCT meshes have free B-rep edges in the file (`bug26451_Test_STEP.stp`); exact `float32` welding suffices, since OCCT gives a shared edge's nodes the same coordinates on both faces, and tolerances make things worse.
- **P-curves:** 373 of the corpus's 468 files with faces have none (94 % of faces): with OCCT's shape healing off, `BRepGProp` areas are 0.
- **Validation properties:** zero volumes in the 'hc' files; `sp7_08_nx-242.stp`'s part values contradict its shape-aspect values by (1/0.0254)^3. Centroids and boxes are never read from files.
- **Other oddities:** `bug25013_25013faces.stp` duplicates two instances; `bug31292.stp` is OCCT's broken-references file; `bug26451_Test_STEP.stp` has `#0` references and syntax errors; external-reference assemblies (`cax_stepLib`) have no geometry; 25 files have nothing to draw; the same models exported by many CAD systems (`trj*_s1-*`, `*as1-*`, the `k1` keys) settle disagreements with OCCT.

## Backlog

- **PMI** (graphical and semantic: `step_tutorial.md`): the importer skips annotation representations. `rec_pracs_pmi_v41.pdf` and `rec_prac_polyline_pres_v23.pdf` in `third_party/mbx-if-recpractices/`. 2D drawings (`GEOMETRICALLY_BOUNDED_2D_WIREFRAME`, e.g. `trj2_d2-db-214.stp` #1032) need their sheets and placement, so they belong with presentation.
- **User-defined attributes** (`rec_prac_user_def_attributes_v18.pdf`): name/value properties on products, occurrences, shape aspects. **Materials:** AP214 material products (`dm1-pe-214.stp`'s Titanium 6-4), densities. **SHUO:** not read yet; per-instance colours come only from context-dependent styles. **Kinematics:** where AP214 and AP242 differ most.
- **Per-instance styles** are implemented but no corpus file has them (unit tests only). **Per-curve colours:** 81 curves beside solids in 24 parts show the part's colour; would need `curveMaterials`.
- **Named coordinate systems:** unused `AXIS2_PLACEMENT_3D`s ('MCS2' in `bug24383_224013.stp`) to list for a viewer.
- **Large files:** byte offsets are `Uint32Array` (4 GiB); 64-bit costs about 8 bytes per instance. On-demand range reading (`Blob.slice`, `fs.read` at an offset) would bound memory, with pass 1 chunked; the user wants large files in the browser as far as possible. The B-rep model is to be built at import and the file dropped (`brep-model.md`). LMP1's STEP (271 MB) spends most of its import in `buildSubset`'s `closure` and garbage collection (not looked into).
- **Part 21 edition 3:** anchors, references and signatures are skipped with a warning; `@name` and `<uri>` values fail their instance's decode.
- Open: whether stepcode's AP242 schema (N11521) is edition 2 or 3; the ISO EXPRESS redistribution terms; whether to ship more dictionaries (AP209, AP214 edition 1).
