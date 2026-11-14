//! The truck tessellation backend: a part's cad-brep model in (built into truck's shells by model.rs), the faces and
//! edges of the part out, with their source ids, as flat arrays in linear memory that ../src/index.ts reads. A plain
//! C ABI (no wasm-bindgen).
//!
//! Workarounds for truck (see docs/backends.md; truck itself is used unchanged):
//! - Shells are built here (model.rs) rather than by truck-stepio's `to_compressed_shell`, so each face and edge
//!   keeps its source id, and a face whose surface or edges don't convert is left out and reported.
//! - B-splines come clamped (the model's: docs/brep-reference.md, "The canonical model"); truck evaluates one over its
//!   whole knot vector, which for an unclamped one yields NaN at the ends.
//! - An edge whose curve evaluates to non-finite points is left out, with its faces: truck would subdivide it until
//!   memory runs out.
//! - A solid's shell that faces the wrong way is reversed, as OCCT's shape healing (ShapeFix_Solid) does: an outer
//!   shell whose closed mesh encloses a negative signed volume, or a void whose mesh encloses a positive one. Some
//!   writers reverse voids twice (docs/step.md).
//! - A face whose mesh runs against all of its loops is reversed: ISO 10303-42 orients a face's loops
//!   counter-clockwise about its normal, but truck sometimes meshes a face inside out.

use std::cell::RefCell;
use std::collections::HashMap;
use truck_meshalgo::prelude::*;
use truck_stepio::r#in::step_geometry::{Curve3D, Surface};
use truck_topology::compress::{CompressedEdge, CompressedEdgeIndex, CompressedShell};

#[path = "../../../cad-brep/include/cad_brep.rs"]
mod cad_brep;
mod model;

// ---- shells, ids attached ----

struct Built {
    shell: CompressedShell<Point3, Curve3D, Surface>,
    face_ids: Vec<u64>,
    edge_ids: Vec<u64>,
}

/// A shell's part in its solid, which fixes the way it must face.
#[derive(Clone, Copy, PartialEq)]
enum Role {
    Outer,
    Void,
    /// A surface model's shell, or a shell on its own: no orientation to check.
    Surface,
}

#[derive(Default)]
struct Diag {
    unconverted_faces: Vec<u64>,
    unconverted_edges: Vec<u64>,
    unmeshed_faces: Vec<u64>,
    skipped_items: Vec<String>,
    /// Faces whose surfaces evaluate to non-finite points (left out).
    nonfinite_faces: Vec<u64>,
    /// Edges whose curves evaluate to non-finite points (left out, as unconverted).
    nonfinite_edges: Vec<u64>,
    /// Solid shells reversed because they faced the wrong way: (id, void or not).
    reversed_shells: Vec<(u64, bool)>,
    /// Solid shells whose faces' meshes disagree in orientation, so the shell's couldn't be checked.
    inconsistent_shells: Vec<u64>,
    /// Solid shells whose mesh isn't closed, so their orientation couldn't be checked.
    unchecked_shells: Vec<u64>,
    /// Solid shells whose mesh's volume is too small or too uncertain to tell their orientation (see `volume_sign`).
    unclear_shells: Vec<u64>,
    /// Faces whose meshes ran against all their loops, reversed (see `loop_sense`).
    flipped_faces: Vec<u64>,
}

/// Whether a surface evaluates to finite points over its parameter range, bounds included (sampled; unbounded
/// directions aren't sampled). truck meshes along a bounded surface's range edges and would subdivide a NaN without
/// end, as for curves.
fn finite_surface(s: &Surface) -> bool {
    let (ur, vr) = s.try_range_tuple();
    let (Some((u0, u1)), Some((v0, v1))) = (ur, vr) else { return true };
    (0..=16).all(|i| {
        (0..=16).all(|j| {
            let p = s.subs(u0 + (u1 - u0) * i as f64 / 16.0, v0 + (v1 - v0) * j as f64 / 16.0);
            p.x.is_finite() && p.y.is_finite() && p.z.is_finite()
        })
    })
}

/// Whether a curve evaluates to finite points along its range (sampled). truck subdivides a curve until each piece is
/// within the tolerance, to a depth of 100, so a curve that yields NaN somewhere is divided without end, until memory
/// runs out.
fn finite_curve(c: &Curve3D) -> bool {
    let (t0, t1) = c.range_tuple();
    (0..=32).all(|i| {
        let p = c.subs(t0 + (t1 - t0) * i as f64 / 32.0);
        p.x.is_finite() && p.y.is_finite() && p.z.is_finite()
    })
}

// ---- meshing and output ----

#[derive(Default)]
struct Out {
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
    faces: Vec<u32>,          // (source id or 0, start, count) per face
    edge_positions: Vec<f32>, // all polylines
    edges: Vec<u32>,          // (source id or 0, start, count, kind) per edge
    edge_angles: Vec<f32>,    // dihedral angle per edge, or -1
    diag: String,
}

const SHARED: u32 = 0;
const SEAM: u32 = 1;
const FREE: u32 = 2;
const DEGENERATE: u32 = 3;

/// A source id as the results give it: 0 for none.
fn id32(id: u64) -> u32 {
    u32::try_from(id).unwrap_or(0)
}

fn key(p: Point3) -> [u64; 3] {
    [p.x.to_bits(), p.y.to_bits(), p.z.to_bits()]
}

/// Whether a shell's face meshes are oriented consistently: no boundary segment traversed in the same direction by
/// two triangles (as happens where one face is flipped against its neighbour). Face meshes share their boundary
/// points exactly, so segments are compared by position.
fn consistent(polys: &[Option<PolygonMesh>]) -> bool {
    let mut seen = std::collections::HashSet::new();
    for p in polys.iter().flatten() {
        let pos = p.positions();
        for tri in p.faces().triangle_iter() {
            for k in 0..3 {
                let (a, b) = (key(pos[tri[k].pos]), key(pos[tri[(k + 1) % 3].pos]));
                if a != b && !seen.insert((a, b)) {
                    return false;
                }
            }
        }
    }
    true
}

/// How many of a face's loop segments its mesh's triangles run along (agree) and against (contra). The loops run
/// counter-clockwise about the face normal (ISO 10303-42) and truck's triangles wind counter-clockwise about theirs,
/// so a loop edge, traversed as the loop uses it, runs along its triangles' boundary. The meshes of a face and its
/// edges share their points exactly.
fn loop_sense(
    poly: &PolygonMesh,
    boundaries: &[Vec<CompressedEdgeIndex>],
    edges: &[CompressedEdge<PolylineCurve<Point3>>],
) -> (usize, usize) {
    let pos = poly.positions();
    let mut half = std::collections::HashSet::new();
    for tri in poly.faces().triangle_iter() {
        for k in 0..3 {
            half.insert((key(pos[tri[k].pos]), key(pos[tri[(k + 1) % 3].pos])));
        }
    }
    let (mut agree, mut contra) = (0, 0);
    for e in boundaries.iter().flatten() {
        let pts: &[Point3] = &edges[e.index].curve;
        for w in pts.windows(2) {
            let (a, b) = if e.orientation { (key(w[0]), key(w[1])) } else { (key(w[1]), key(w[0])) };
            if half.contains(&(a, b)) {
                agree += 1;
            } else if half.contains(&(b, a)) {
                contra += 1;
            }
        }
    }
    (agree, contra)
}

/// The sign of the volume a closed triangle mesh encloses (positive when its triangles face outward), or None when
/// truck's mesh can't tell. Six times the volume measured from a point r is 6V(r) = 6V(0) - r*N, N the sum of the
/// triangles' cross(b - a, c - a), which is zero only when the mesh closes up geometrically, as well as topologically:
/// where truck's face meshes leave gaps or overhang their boundaries, the volume depends on r. So the sign counts only
/// if it's the same from every r in the mesh's bounding box. And it must be at least 1% of the sum of the triangles'
/// |6V| (from the box's centre): in a thin part, the faces' contributions nearly cancel, and one face that truck
/// meshes wrongly, inside closed boundaries, outweighs the part's volume (docs/backends.md).
fn volume_sign(polys: &[Option<PolygonMesh>]) -> Option<f64> {
    let mut lo = Point3::new(f64::MAX, f64::MAX, f64::MAX);
    let mut hi = Point3::new(f64::MIN, f64::MIN, f64::MIN);
    for q in polys.iter().flatten().flat_map(|p| p.positions()) {
        lo = Point3::new(lo.x.min(q.x), lo.y.min(q.y), lo.z.min(q.z));
        hi = Point3::new(hi.x.max(q.x), hi.y.max(q.y), hi.z.max(q.z));
    }
    let r = lo.midpoint(hi);
    let (mut v, mut total, mut n) = (0.0, 0.0, Vector3::new(0.0, 0.0, 0.0));
    for p in polys.iter().flatten() {
        let pos = p.positions();
        for tri in p.faces().triangle_iter() {
            let (a, b, c) = (pos[tri[0].pos] - r, pos[tri[1].pos] - r, pos[tri[2].pos] - r);
            let x = a.dot(b.cross(c));
            v += x;
            total += x.abs();
            n += (b - a).cross(c - a);
        }
    }
    let h = (hi - lo) / 2.0;
    let spread = n.x.abs() * h.x + n.y.abs() * h.y + n.z.abs() * h.z;
    (v.abs() > spread && v.abs() >= 0.01 * total).then(|| v.signum())
}

#[allow(clippy::too_many_arguments)]
fn mesh_shell(
    b: &Built, id: u64, role: Role, tol: f64, origin: Point3, with_edges: bool, out: &mut Out, diag: &mut Diag,
) {
    let meshed = b.shell.robust_triangulation(tol);
    // Which faces use each edge (one entry per use).
    let mut uses: Vec<Vec<usize>> = vec![Vec::new(); meshed.edges.len()];
    for (k, face) in meshed.faces.iter().enumerate() {
        for e in face.boundaries.iter().flatten() {
            uses[e.index].push(k);
        }
    }
    // The face meshes, each facing the way its face does: reversed first if it runs against all its loops (in the
    // face's own sense, before its orientation in the shell).
    let mut polys: Vec<Option<PolygonMesh>> = Vec::with_capacity(meshed.faces.len());
    for (k, face) in meshed.faces.iter().enumerate() {
        polys.push(face.surface.clone().map(|mut poly| {
            let (agree, contra) = loop_sense(&poly, &face.boundaries, &meshed.edges);
            if contra > 0 && agree == 0 {
                poly.invert();
                diag.flipped_faces.push(b.face_ids[k]);
            }
            if !face.orientation {
                poly.invert();
            }
            poly
        }));
    }
    // A solid's shell must face out of the material: outward for the outer shell, into the void for a void. Checked
    // only when the mesh is closed (every face meshed and every edge used twice), its faces agree (`consistent`), and
    // the volume's sign is clear (`volume_sign`): a face truck orients against its neighbours, or meshes wrongly, would
    // make the volume meaningless. (A face that didn't convert leaves its neighbours' edges used once, unless what
    // remains is closed anyway.)
    if role != Role::Surface {
        let closed = polys.iter().all(Option::is_some) && uses.iter().all(|u| u.len() == 2);
        if !closed {
            diag.unchecked_shells.push(id);
        } else if !consistent(&polys) {
            diag.inconsistent_shells.push(id);
        } else {
            match volume_sign(&polys) {
                None => diag.unclear_shells.push(id),
                Some(sign) if (sign < 0.0) == (role == Role::Outer) => {
                    polys.iter_mut().flatten().for_each(|p| p.invert());
                    diag.reversed_shells.push((id, role == Role::Void));
                }
                Some(_) => {}
            }
        }
    }
    // Per face: each boundary position's normal, for dihedral angles.
    let mut face_normals: Vec<HashMap<[u64; 3], Vector3>> = Vec::new();
    for (k, poly) in polys.iter().enumerate() {
        let fid = b.face_ids[k];
        let Some(poly) = poly else {
            diag.unmeshed_faces.push(fid);
            face_normals.push(HashMap::new());
            continue;
        };
        let (pos, nor) = (poly.positions(), poly.normals());
        let base = (out.positions.len() / 3) as u32;
        let start = out.indices.len();
        let mut welded: HashMap<(usize, Option<usize>), u32> = HashMap::new();
        let mut normals = HashMap::new();
        for tri in poly.faces().triangle_iter() {
            let flat = (pos[tri[1].pos] - pos[tri[0].pos]).cross(pos[tri[2].pos] - pos[tri[0].pos]);
            for v in tri {
                let n = v.nor.and_then(|i| nor.get(i)).unwrap_or(flat).normalize();
                let next = base + welded.len() as u32;
                let i = *welded.entry((v.pos, v.nor)).or_insert_with(|| {
                    let p = pos[v.pos];
                    out.positions.extend([(p.x - origin.x) as f32, (p.y - origin.y) as f32, (p.z - origin.z) as f32]);
                    out.normals.extend([n.x as f32, n.y as f32, n.z as f32]);
                    next
                });
                normals.entry(key(pos[v.pos])).or_insert(n);
                out.indices.push(i);
            }
        }
        out.faces.extend([id32(fid), start as u32, (out.indices.len() - start) as u32]);
        face_normals.push(normals);
    }
    if !with_edges {
        return;
    }
    for (j, edge) in meshed.edges.iter().enumerate() {
        let pts: &[Point3] = &edge.curve;
        let start = out.edge_positions.len() / 3;
        for p in pts {
            out.edge_positions.extend([(p.x - origin.x) as f32, (p.y - origin.y) as f32, (p.z - origin.z) as f32]);
        }
        let u = &uses[j];
        let degenerate = pts.iter().all(|p| p.distance(pts[0]) <= 1e-12 * (1.0 + pts[0].to_vec().magnitude()));
        let kind = if degenerate {
            DEGENERATE
        } else if u.len() == 1 {
            FREE
        } else if u.len() == 2 && u[0] == u[1] {
            SEAM
        } else if u.len() >= 2 {
            SHARED
        } else {
            FREE
        };
        let mut angle: f32 = -1.0;
        if kind == SHARED {
            let (fa, fb) = (&face_normals[u[0]], &face_normals[*u.iter().find(|&&k| k != u[0]).unwrap_or(&u[1])]);
            for p in pts {
                if let (Some(a), Some(b)) = (fa.get(&key(*p)), fb.get(&key(*p))) {
                    angle = angle.max(a.dot(*b).clamp(-1.0, 1.0).acos() as f32);
                }
            }
        }
        out.edges.extend([id32(b.edge_ids[j]), start as u32, pts.len() as u32, kind]);
        out.edge_angles.push(angle);
    }
}

/// The model's solid and sheet bodies' shells, built from its rows (model.rs), meshed.
fn run_model(data: &[u8], tol: f64, origin: Point3, with_edges: bool) -> Result<(Out, Diag), String> {
    let m = model::Model::open(data)?;
    let mut diag = Diag::default();
    let mut out = Out::default();
    for (member, role) in m.shells(&mut diag) {
        let (b, id) = m.build_shell(member, &mut diag);
        mesh_shell(&b, id, role, tol, origin, with_edges, &mut out, &mut diag);
    }
    Ok((out, diag))
}

fn diag_json(d: &Diag) -> String {
    let mut m = serde_json::Map::new();
    m.insert("unconvertedFaces".into(), d.unconverted_faces.clone().into());
    m.insert("unconvertedEdges".into(), d.unconverted_edges.clone().into());
    m.insert("nonfiniteEdges".into(), d.nonfinite_edges.clone().into());
    m.insert("nonfiniteFaces".into(), d.nonfinite_faces.clone().into());
    m.insert("unmeshedFaces".into(), d.unmeshed_faces.clone().into());
    m.insert("skippedItems".into(), d.skipped_items.clone().into());
    let reversed: Vec<_> = d.reversed_shells.iter().map(|&(id, void)| serde_json::json!([id, void])).collect();
    m.insert("reversedShells".into(), reversed.into());
    m.insert("uncheckedShells".into(), d.unchecked_shells.clone().into());
    m.insert("inconsistentShells".into(), d.inconsistent_shells.clone().into());
    m.insert("unclearShells".into(), d.unclear_shells.clone().into());
    m.insert("flippedFaces".into(), d.flipped_faces.clone().into());
    serde_json::Value::Object(m).to_string()
}

// ---- the C ABI ----

thread_local! {
    static RESULT: RefCell<Out> = RefCell::new(Out::default());
}

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    /// Supplied by the host: receives the panic message just before the module traps.
    fn tess_panic(ptr: *const u8, len: usize);
}

#[no_mangle]
pub extern "C" fn tess_init() {
    std::panic::set_hook(Box::new(|info| {
        let s = info.to_string();
        #[cfg(target_arch = "wasm32")]
        unsafe {
            tess_panic(s.as_ptr(), s.len())
        };
        #[cfg(not(target_arch = "wasm32"))]
        eprintln!("{s}");
    }));
}

#[no_mangle]
pub extern "C" fn tess_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` must come from `tess_alloc`.
#[no_mangle]
pub unsafe extern "C" fn tess_dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// Tessellate a cad-brep model of `len` bytes at `ptr` (the model route); 0 on success, 1 on failure (the
/// diagnostics say why).
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn tess_run_model(
    ptr: *const u8, len: usize, tol: f64, ox: f64, oy: f64, oz: f64, edges: i32,
) -> i32 {
    let data = std::slice::from_raw_parts(ptr, len);
    finish(run_model(data, tol, Point3::new(ox, oy, oz), edges != 0))
}

fn finish(r: Result<(Out, Diag), String>) -> i32 {
    let (out, rc) = match r {
        Ok((mut out, d)) => {
            out.diag = diag_json(&d);
            (out, 0)
        }
        Err(e) => (Out { diag: serde_json::json!({ "error": e }).to_string(), ..Out::default() }, 1),
    };
    RESULT.with(|r| *r.borrow_mut() = out);
    rc
}

/// The address of one result array: 0 positions, 1 normals (f32 x 3), 2 indices (u32), 3 faces (u32 x 3),
/// 4 edge positions (f32 x 3), 5 edges (u32 x 4), 6 edge angles (f32), 7 diagnostics (UTF-8 JSON).
#[no_mangle]
pub extern "C" fn tess_ptr(which: i32) -> *const u8 {
    RESULT.with(|r| {
        let r = r.borrow();
        match which {
            0 => r.positions.as_ptr() as *const u8,
            1 => r.normals.as_ptr() as *const u8,
            2 => r.indices.as_ptr() as *const u8,
            3 => r.faces.as_ptr() as *const u8,
            4 => r.edge_positions.as_ptr() as *const u8,
            5 => r.edges.as_ptr() as *const u8,
            6 => r.edge_angles.as_ptr() as *const u8,
            _ => r.diag.as_ptr(),
        }
    })
}

/// The length of one result array, in elements (bytes for the diagnostics).
#[no_mangle]
pub extern "C" fn tess_len(which: i32) -> usize {
    RESULT.with(|r| {
        let r = r.borrow();
        match which {
            0 => r.positions.len(),
            1 => r.normals.len(),
            2 => r.indices.len(),
            3 => r.faces.len(),
            4 => r.edge_positions.len(),
            5 => r.edges.len(),
            6 => r.edge_angles.len(),
            _ => r.diag.len(),
        }
    })
}

#[no_mangle]
pub extern "C" fn tess_free() {
    RESULT.with(|r| *r.borrow_mut() = Out::default());
}

// Native tests: (cd native && CARGO_TARGET_DIR=../build/target cargo test --release --lib)
#[cfg(test)]
mod tests {
    use super::*;

    fn mesh(positions: Vec<Point3>, tris: &[[usize; 3]]) -> Option<PolygonMesh> {
        let attrs = StandardAttributes { positions, uv_coords: vec![], normals: vec![] };
        Some(PolygonMesh::new(attrs, Faces::from_iter(tris)))
    }

    #[test]
    fn a_volume_sign_needs_a_closed_mesh_and_a_volume_beside_its_faces_parts() {
        // A unit cube, outward and inward.
        let cube: Vec<Point3> =
            (0..8).map(|i| Point3::new((i & 1) as f64, (i >> 1 & 1) as f64, (i >> 2 & 1) as f64)).collect();
        let out = [
            [0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4],
            [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5],
        ];
        let inward: Vec<[usize; 3]> = out.iter().map(|&[a, b, c]| [a, c, b]).collect();
        assert_eq!(volume_sign(&[mesh(cube.clone(), &out)]), Some(1.0));
        assert_eq!(volume_sign(&[mesh(cube.clone(), &inward)]), Some(-1.0));
        // Open along z only: a 2 x 2 square over a 1 x 1 one, both facing +z. 6V from the box centre is 3, but
        // anywhere from -2 to 8 in the box.
        let sq = |h: f64, z: f64| {
            vec![Point3::new(-h, -h, z), Point3::new(h, -h, z), Point3::new(h, h, z), Point3::new(-h, h, z)]
        };
        let two = [mesh(sq(0.5, 0.0), &[[0, 1, 2], [0, 2, 3]]), mesh(sq(1.0, 1.0), &[[0, 1, 2], [0, 2, 3]])];
        assert_eq!(volume_sign(&two), None);
        // A box with walls of thickness t: the outer cube outward, an inner one inward. The faces' parts of 6V from the
        // centre nearly cancel: the volume is 3% of their sum at t = 0.01, 0.3% at t = 0.001.
        let walls = |t: f64| {
            let inner: Vec<Point3> = cube
                .iter()
                .map(|p| Point3::new(t + (1.0 - 2.0 * t) * p.x, t + (1.0 - 2.0 * t) * p.y, t + (1.0 - 2.0 * t) * p.z))
                .collect();
            [mesh(cube.clone(), &out), mesh(inner, &inward)]
        };
        assert_eq!(volume_sign(&walls(0.01)), Some(1.0));
        assert_eq!(volume_sign(&walls(0.001)), None);
    }
}
