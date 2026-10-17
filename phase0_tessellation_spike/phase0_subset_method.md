# Phase 0: how the per-part subsets were made

This is how the spike cut individual parts out of the source STEP files. The code is `make_subsets.mjs`, which uses `closure` and `emitSubset` from `p21.mjs`. The results are in `phase0_results.md`.

Each subset is the forward-reference closure of one shape representation, with the original bytes and `#IDs` kept.

## Choosing the roots

The script indexes the whole file, then takes every entity whose type ends in `SHAPE_REPRESENTATION` and that directly references a solid-like item: `MANIFOLD_SOLID_BREP`, `BREP_WITH_VOIDS`, `SHELL_BASED_SURFACE_MODEL` or `FACETED_BREP`. Complex `(...)` instances count. In practice, most roots were `ADVANCED_BREP_SHAPE_REPRESENTATION`s, plus some `MANIFOLD_SURFACE_SHAPE_REPRESENTATION`s.

This gave 76 roots for the NIST and gkv311 files and 112 for the bicycle.

So a "part" here is one shape representation, not one product. The roots were found by entity type, not by walking the product or assembly structure.

## Closure

Starting from the root, the script follows every `#N` reference in the parameters (outside strings and comments) until no new entities turn up. Because the representation references its context, the closure picks up the units and uncertainty context along with all the geometry and topology.

Anything that only points *at* the representation is left out:

- the product and its definitions, and `SHAPE_DEFINITION_REPRESENTATION`
- assembly links and transforms: `NEXT_ASSEMBLY_USAGE_OCCURRENCE`, `CONTEXT_DEPENDENT_SHAPE_REPRESENTATION` and `REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION`
- styles and colors (`STYLED_ITEM`)
- PMI and tessellated presentation geometry

## Writing the file

The original header is written unchanged. Then each entity in the closure is written in its original order, sliced byte-for-byte from the source, with no renumbering.

Each root produced two files:

- `<file>.absr.<rootId>.stp`: the bare closure.
- `<file>.absr+wrap.<rootId>.stp`: the same, plus the 8-entity synthetic product wrapper, with fresh IDs above the file's maximum:

  ```
  APPLICATION_CONTEXT, PRODUCT_CONTEXT, PRODUCT, PRODUCT_DEFINITION_FORMATION,
  PRODUCT_DEFINITION_CONTEXT, PRODUCT_DEFINITION, PRODUCT_DEFINITION_SHAPE,
  SHAPE_DEFINITION_REPRESENTATION(#pds, #root)
  ```

The subsets are in `out` (NIST and gkv311) and `out_bike` (bicycle).

`out` also holds 116 `.solid.*` files. They came from an earlier `occt-import-js` pass (`occt_test.mjs`) that took the closure of each solid instead of the representation. Those lose the unit context, and the representation-rooted subsets replaced them.

## How the results were checked

- **Face IDs:** each STEP face's `VERTEX_POINT` coordinates were checked against the vertices in the mesh range carrying that face's ID. The coordinates came from an index of the original file.
- **Area:** each part's area was compared across backends, with the custom OCCT 8.1 build as the reference.
- **Bare vs. wrapped identity:** the custom build gives byte-identical output for both.
- **Edges:** polyline endpoints were checked against the `EDGE_CURVE` vertices in the original file.
- **Whole file vs. subsets:** compared only for total time and triangle count. For example, the bicycle took 31.0 s as a whole file and 18.3 s summed over its 112 parts.

## Gaps

1. **No per-part comparison with the whole file.** Nothing checked that a part tessellated alone matches the same part tessellated inside the whole file (face count, area). The checks above work on subsets or across backends. This is the obvious test to add for a direct equivalence check.
2. **Part-local coordinates only.** Assembly transforms aren't applied. That's the intended split, since the host does the instancing, but placement was never validated.
3. **Colors, styles and PMI were never tested.** They only point into the closure. Getting them for a part needs a reverse-reference pass, which the architecture assigns to the JS side.
4. **Some representation types were skipped as roots:**
   - representations holding only `MAPPED_ITEM`s
   - wireframe and `GEOMETRICALLY_BOUNDED_*` representations
   - AP242 `TESSELLATED_SHAPE_REPRESENTATION`

   A representation that reaches its solids only through `MAPPED_ITEM` would be missed. The closure would follow the map into the mapped representation, but that representation is never picked as a root.
5. **The indexer is crude.** It treats every `#N` outside strings as a reference, which can only over-include. It did resynchronize on the corrupted file (`bug32314_corrupted.stp`). But it isn't a validating parser, so a subtly malformed subset would only show up if a backend rejected it.
