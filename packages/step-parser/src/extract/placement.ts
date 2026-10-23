// Placements and transformations as matrices, following ISO 10303-42's definitions: axis2_placement_3d/2d axes
// (build_axes, build_2axes, first_proj_axis), cartesian_transformation_operator (base_axis, second_proj_axis), and
// ISO 10303-43's item_defined_transformation and mapped_item.

import { cross, dot, fromAxes, invertAffine, multiply, normalize, scale, scaling, sub, type Mat4,
  type Vec3 } from './math.ts';
import { numbersOf, type Reader } from './reader.ts';

function vec(v: number[] | undefined): Vec3 | undefined {
  if (!v || v.length < 2 || v.length > 3 || !v.every(Number.isFinite)) return undefined;
  return [v[0]!, v[1]!, v[2] ?? 0];
}

/** A CARTESIAN_POINT's coordinates (2D points get z = 0). */
export function point(r: Reader, p: number): Vec3 | undefined {
  return r.is(p, 'CARTESIAN_POINT') ? vec(numbersOf(r.attr(p, 'coordinates'))) : undefined;
}

/** A DIRECTION's ratios, not normalized. */
export function direction(r: Reader, p: number): Vec3 | undefined {
  return r.is(p, 'DIRECTION') ? vec(numbersOf(r.attr(p, 'direction_ratios'))) : undefined;
}

/** first_proj_axis: the unit x axis given the z axis and an optional reference direction. */
function firstProjAxis(z: Vec3, arg: Vec3 | undefined): Vec3 | undefined {
  let v: Vec3;
  if (!arg) {
    v = Math.abs(z[0]) === 1 && z[1] === 0 && z[2] === 0 ? [0, 1, 0] : [1, 0, 0];
  } else {
    if (!normalize(cross(arg, z))) return undefined; // parallel to z
    v = normalize(arg)!;
  }
  // Projected twice: once can leave an error up to 1e-8 when v is nearly parallel to z (OCC5099.stp has an axis
  // 1.6e-8 off the x axis, so the default v = (1,0,0) nearly cancels).
  const x = normalize(sub(v, scale(z, dot(v, z))));
  return x && normalize(sub(x, scale(z, dot(x, z))));
}

/** second_proj_axis: the unit y axis given z, x and an optional direction. */
function secondProjAxis(z: Vec3, x: Vec3, arg: Vec3 | undefined): Vec3 | undefined {
  const v = arg ?? cross(z, x);
  return normalize(sub(sub(v, scale(z, dot(v, z))), scale(x, dot(v, x))));
}

/**
 * The matrix of an AXIS2_PLACEMENT_3D or AXIS2_PLACEMENT_2D (or a CARTESIAN_TRANSFORMATION_OPERATOR, which can stand
 * where a placement is expected). Undefined, with a diagnostic, when it can't be built.
 */
export function placement(r: Reader, p: number): Mat4 | undefined {
  if (r.is(p, 'CARTESIAN_TRANSFORMATION_OPERATOR')) return operator(r, p);
  const is3d = r.is(p, 'AXIS2_PLACEMENT_3D');
  if (!is3d && !r.is(p, 'AXIS2_PLACEMENT_2D')) {
    r.warn(`expected a placement, got ${r.model.types(p).join('+') || 'nothing'}`, p >= 0 ? p : undefined);
    return undefined;
  }
  const o = point(r, r.ref(p, 'location'));
  if (!o) { r.warn('placement without a valid location', p); return undefined; }
  const axisP = is3d ? r.ref(p, 'axis') : -1;
  const refP = r.ref(p, 'ref_direction');
  const axis = axisP >= 0 ? direction(r, axisP) : undefined;
  const ref = refP >= 0 ? direction(r, refP) : undefined;
  const z = is3d ? (axis ? normalize(axis) : [0, 0, 1] as Vec3) : [0, 0, 1] as Vec3;
  if (!z) { r.warn('placement axis is a zero vector', p); return undefined; }
  let x = firstProjAxis(z, ref);
  if (!x) {
    // Part 42 leaves this undefined; use the default direction, as if ref_direction were absent.
    r.warn('placement ref_direction is parallel to its axis; using the default', p);
    x = firstProjAxis(z, undefined)!;
  }
  return fromAxes(x, cross(z, x), z, o);
}

/** The matrix of a CARTESIAN_TRANSFORMATION_OPERATOR (2D or 3D, uniform or not), from base_axis. */
export function operator(r: Reader, p: number): Mat4 | undefined {
  const d = (name: string) => { const q = r.ref(p, name); return q >= 0 ? direction(r, q) : undefined; };
  const o = point(r, r.ref(p, 'local_origin'));
  if (!o) { r.warn('transformation operator without a valid local_origin', p); return undefined; }
  const s = r.num(p, 'scale') ?? 1;
  const is3d = r.is(p, 'CARTESIAN_TRANSFORMATION_OPERATOR_3D');
  const z = is3d ? (normalize(d('axis3') ?? [0, 0, 1])) : [0, 0, 1] as Vec3;
  const x = z && firstProjAxis(z, d('axis1'));
  const y = z && x && secondProjAxis(z, x, d('axis2'));
  if (!z || !x || !y) { r.warn('transformation operator with degenerate axes', p); return undefined; }
  // Non-uniform operators have their own scales for axes 2 and 3.
  const s2 = r.num(p, 'scale2') ?? s, s3 = r.num(p, 'scale3') ?? s;
  return fromAxes(scale(x, s), scale(y, s2), scale(z, s3), o);
}

/**
 * The matrix of an ITEM_DEFINED_TRANSFORMATION (taking transform_item_1 onto transform_item_2) or of a
 * transformation operator, from the coordinates of the first item's representation to those of the second's.
 * `unitScale` is the first representation's length unit in units of the second's (1 when they agree).
 *
 * Given the two representations, an item_defined_transformation whose items lie in the opposite representations
 * (transform_item_1 in the second, transform_item_2 in the first) has them swapped back, as OCCT does, unless
 * `keepItemOrder` is set: Alibre writes them that way but means the order as written (see products.ts).
 */
export function transformation(
  r: Reader, p: number, unitScale = 1, reps?: [number, number], keepItemOrder = false,
): Mat4 | undefined {
  if (r.is(p, 'ITEM_DEFINED_TRANSFORMATION')) {
    let a = r.ref(p, 'transform_item_1'), b = r.ref(p, 'transform_item_2');
    if (reps) {
      const [in1, in2] = reps.map((q) => new Set(r.refs(q, 'items')));
      if (!in1!.has(a) && !in2!.has(b) && in1!.has(b) && in2!.has(a)) {
        if (keepItemOrder) {
          r.warn('transformation items are in the opposite representations; kept as written (Alibre)', p, 'info');
        } else {
          r.warn('transformation items are in the opposite representations; swapped back', p, 'info');
          [a, b] = [b, a];
        }
      } else if (!in1!.has(a) || !in2!.has(b)) {
        r.warn('transformation item not in its representation', p);
      }
    }
    return between(a, b);
  }
  if (r.is(p, 'CARTESIAN_TRANSFORMATION_OPERATOR')) {
    const m = operator(r, p);
    return m && (unitScale === 1 ? m : multiply(m, scaling(unitScale)));
  }
  r.warn(`expected a transformation, got ${r.model.types(p).join('+') || 'nothing'}`, p >= 0 ? p : undefined);
  return undefined;

  // to · S · from⁻¹: into the first item's frame, convert units, then out of the second item's frame.
  function between(fromP: number, toP: number): Mat4 | undefined {
    const from = placement(r, fromP);
    const to = placement(r, toP);
    const fi = from && invertAffine(from);
    if (!fi || !to) return undefined;
    return multiply(to, unitScale === 1 ? fi : multiply(scaling(unitScale), fi));
  }
}

/**
 * A MAPPED_ITEM: the mapped representation's position, and the matrix taking its mapping_origin onto the
 * mapping_target. `unitScale(rep)` gives the mapped representation's length unit in units of the representation
 * that holds the mapped item.
 */
export function mappedItem(r: Reader, p: number, unitScale: (rep: number) => number = () => 1): {
  representation: number; matrix: Mat4 } | undefined {
  const map = r.ref(p, 'mapping_source');
  const rep = r.ref(map, 'mapped_representation');
  if (rep < 0) { r.warn('mapped item without a mapped representation', p); return undefined; }
  const origin = placement(r, r.ref(map, 'mapping_origin'));
  const target = placement(r, r.ref(p, 'mapping_target'));
  const oi = origin && invertAffine(origin);
  if (!oi || !target) return undefined;
  const s = unitScale(rep);
  return { representation: rep, matrix: multiply(target, s === 1 ? oi : multiply(scaling(s), oi)) };
}

