//! The truck tessellation backend: a STEP subset in, the faces and edges of one shape representation out, with
//! their STEP entity ids, as flat arrays in linear memory that ../src/index.ts reads. A plain C ABI (no wasm-bindgen).
//!
//! Workarounds for truck (see docs/phase3_progress.md, step 2; truck itself is used unchanged):
//! - Shells are built here rather than by `Table::to_compressed_shell`. truck numbers a vertex or edge before
//!   converting it, so one that fails to convert shifts every later index, and it drops faces it can't convert
//!   without saying which. Here each face and edge keeps its STEP id, and a face whose surface or edges don't
//!   convert is left out and reported.
//! - An AXIS2_PLACEMENT_3D without a ref_direction whose axis is ±x gets the ref_direction (0, 1, 0), as ISO
//!   10303-42's `first_proj_axis` prescribes. truck always defaults it to (1, 0, 0), so the placement's x axis
//!   becomes NaN, and meshing a circle on it panics (`tolerance must be no less than 1e-6`, truck-geometry
//!   `specifieds/circle.rs`, since NaN fails the check).
//! - A SURFACE_CURVE (or SEAM_CURVE) is read by its 3D curve, as OCCT does (StepToGeom::MakeCurve), whatever its
//!   master_representation says. truck follows a .PCURVE_S1. or .PCURVE_S2. master and evaluates the pcurve on its
//!   surface, which in some files yields NaN (and then see `finite_curve`).
//! - A CONICAL_SURFACE's semi_angle is converted to radians from the plane angle unit of the root representation's
//!   context (often degrees): truck has no unit handling, so it takes the value as radians.
//! - A TOROIDAL_SURFACE's radii are taken as absolute values, as OCCT does (StepToGeom::MakeToroidalSurface): some
//!   writers give a negative major radius, which truck's Torus::new rejects with a panic.
//! - An edge whose curve evaluates to non-finite points is left out, with its faces: truck would subdivide it until
//!   memory runs out.
//! - A solid's shell that faces the wrong way is reversed, as OCCT's shape healing (ShapeFix_Solid) does: an outer
//!   shell whose closed mesh encloses a negative signed volume, or a void whose mesh encloses a positive one. Some
//!   writers reverse voids twice (docs/phase3_progress.md, step 2).

use std::cell::RefCell;
use std::collections::HashMap;
use truck_meshalgo::prelude::*;
use std::str::FromStr;
use truck_stepio::r#in::ruststep::ast::{DataSection, EntityInstance, Name, Parameter};
use truck_stepio::r#in::ruststep::tables::{EntityTable, IntoOwned, PlaceHolder};
use truck_stepio::r#in::step_geometry::{Curve3D, Surface};
use truck_stepio::r#in::*;
use truck_topology::compress::{CompressedEdge, CompressedEdgeIndex, CompressedFace, CompressedShell};

// ---- building shells, ids attached ----

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
    /// Instances truck's parser can't read (left out; see `read_instances`).
    unread_instances: Vec<u64>,
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
    /// CONICAL_SURFACEs whose semi_angle was converted to radians.
    cones: usize,
    /// TOROIDAL_SURFACEs whose negative radii were made positive.
    tori: usize,
    /// SURFACE_CURVEs and SEAM_CURVEs switched from a pcurve to their 3D curve (see the module comment).
    curves_3d: usize,
    /// AXIS2_PLACEMENT_3Ds given the standard's default ref_direction (see the module comment).
    fixed_placements: usize,
}

fn entity<T>(p: &PlaceHolder<T>) -> Option<u64> {
    match p {
        PlaceHolder::Ref(Name::Entity(id)) => Some(*id),
        _ => None,
    }
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

/// An ORIENTED_EDGE or EDGE_CURVE id → the EDGE_CURVE id and the orientation.
fn edge_ref(t: &Table, id: u64) -> Option<(u64, bool)> {
    if let Some(oe) = t.oriented_edge.get(&id) {
        return Some((entity(&oe.edge_element)?, oe.orientation));
    }
    t.edge_curve.contains_key(&id).then_some((id, true))
}

/// An ORIENTED_FACE or FACE_SURFACE (ADVANCED_FACE) id → the face's id, holder and orientation.
fn face_ref(t: &Table, id: u64) -> Option<(u64, &FaceSurfaceHolder, bool)> {
    if let Some(f) = t.face_surface.get(&id) {
        return Some((id, f, true));
    }
    let of = t.oriented_face.get(&id)?;
    let fid = entity(&of.face_element)?;
    Some((fid, t.face_surface.get(&fid)?, of.orientation))
}

struct ShellBuilder<'a> {
    t: &'a Table,
    out: Built,
    vertices: HashMap<u64, Option<usize>>,
    edges: HashMap<u64, Option<usize>>,
}

impl<'a> ShellBuilder<'a> {
    fn vertex(&mut self, id: u64) -> Option<usize> {
        if let Some(v) = self.vertices.get(&id) {
            return *v;
        }
        let v = EntityTable::<VertexPointHolder>::get_owned(self.t, id).ok().map(|vp| {
            self.out.shell.vertices.push(Point3::from(&vp.vertex_geometry));
            self.out.shell.vertices.len() - 1
        });
        self.vertices.insert(id, v);
        v
    }

    fn edge(&mut self, id: u64, diag: &mut Diag) -> Option<usize> {
        if let Some(e) = self.edges.get(&id) {
            return *e;
        }
        let e = (|| {
            let h = self.t.edge_curve.get(&id)?;
            let (a, b) = (entity(&h.edge_start)?, entity(&h.edge_end)?);
            let curve = EntityTable::<EdgeCurveHolder>::get_owned(self.t, id).ok()?.parse_curve3d().ok()?;
            if !finite_curve(&curve) {
                diag.nonfinite_edges.push(id);
                return None;
            }
            let vertices = (self.vertex(a)?, self.vertex(b)?);
            self.out.shell.edges.push(CompressedEdge { vertices, curve });
            self.out.edge_ids.push(id);
            Some(self.out.shell.edges.len() - 1)
        })();
        if e.is_none() && diag.nonfinite_edges.last() != Some(&id) {
            diag.unconverted_edges.push(id);
        }
        self.edges.insert(id, e);
        e
    }

    /// One face's loops, as truck's `face_bound_to_edges` builds them; None if any edge didn't convert.
    fn boundaries(&mut self, face: &FaceSurfaceHolder, diag: &mut Diag) -> Option<Vec<Vec<CompressedEdgeIndex>>> {
        let mut out = Vec::new();
        for b in &face.bounds {
            let bound = self.t.face_bound.get(&entity(b)?)?;
            let lp = self.t.edge_loop.get(&entity(&bound.bound)?)?;
            let mut wire = Vec::new();
            for e in &lp.edge_list {
                let (eid, ori) = edge_ref(self.t, entity(e)?)?;
                let index = self.edge(eid, diag)?;
                wire.push(CompressedEdgeIndex { index, orientation: ori == bound.orientation });
            }
            if !bound.orientation {
                wire.reverse();
            }
            out.push(wire);
        }
        Some(out)
    }

    fn face(&mut self, cfs: u64, flip: bool, diag: &mut Diag) {
        let Some((fid, face, orientation)) = face_ref(self.t, cfs) else {
            diag.unconverted_faces.push(cfs);
            return;
        };
        let surface = (|| {
            let s: SurfaceAny = face.face_geometry.clone().into_owned(self.t).ok()?;
            let mut s = Surface::try_from(&s).ok()?;
            if !face.same_sense {
                s.invert();
            }
            Some(s)
        })();
        if surface.as_ref().is_some_and(|s| !finite_surface(s)) {
            diag.nonfinite_faces.push(fid);
            return;
        }
        match (surface, self.boundaries(face, diag)) {
            (Some(surface), Some(boundaries)) => {
                self.out.shell.faces.push(CompressedFace { surface, boundaries, orientation: orientation != flip });
                self.out.face_ids.push(fid);
            }
            _ => diag.unconverted_faces.push(fid),
        }
    }
}

/// A CLOSED_SHELL or OPEN_SHELL, or an ORIENTED_ one of them.
fn build_shell(t: &Table, id: u64, diag: &mut Diag) -> Option<Built> {
    let (shell, flip) = match t.shell.get(&id) {
        Some(s) => (s, false),
        None => {
            let os = t.oriented_shell.get(&id)?;
            (t.shell.get(&entity(&os.shell_element)?)?, !os.orientation)
        }
    };
    let empty = CompressedShell { vertices: vec![], edges: vec![], faces: vec![] };
    let mut b = ShellBuilder { t, out: Built { shell: empty, face_ids: vec![], edge_ids: vec![] }, vertices: HashMap::new(), edges: HashMap::new() };
    for f in &shell.cfs_faces {
        match entity(f) {
            Some(cfs) => b.face(cfs, flip, diag),
            None => diag.unconverted_faces.push(0),
        }
    }
    Some(b.out)
}

/// The shells of a representation item: a MANIFOLD_SOLID_BREP (or BREP_WITH_VOIDS), a SHELL_BASED_SURFACE_MODEL or
/// a shell. Anything else is listed as skipped, except placements.
fn item_shells(t: &Table, id: u64, name: &str, diag: &mut Diag, out: &mut Vec<(u64, Role)>) {
    if let Some(s) = t.manifold_solid_brep.get(&id) {
        out.extend(entity(&s.outer).map(|i| (i, Role::Outer)));
        out.extend(s.voids.iter().filter_map(entity).map(|i| (i, Role::Void)));
    } else if let Some(m) = t.shell_based_surface_model.get(&id) {
        out.extend(m.sbsm_boundary.iter().filter_map(entity).map(|i| (i, Role::Surface)));
    } else if t.shell.contains_key(&id) || t.oriented_shell.contains_key(&id) {
        out.push((id, Role::Surface));
    } else if !name.starts_with("AXIS2_PLACEMENT") {
        diag.skipped_items.push(format!("{name} #{id}"));
    }
}

fn record_name(e: &EntityInstance) -> String {
    match e {
        EntityInstance::Simple { record, .. } => record.name.clone(),
        EntityInstance::Complex { subsuper, .. } => subsuper.0.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join("+"),
    }
}

/// The ids in a representation's `items` (its second attribute), simple or complex.
fn root_items(e: &EntityInstance) -> Option<Vec<u64>> {
    let params = match e {
        EntityInstance::Simple { record, .. } => &record.parameter,
        EntityInstance::Complex { subsuper, .. } => &subsuper.0.iter().find(|r| r.name == "REPRESENTATION")?.parameter,
    };
    let Parameter::List(ps) = params else { return None };
    let Some(Parameter::List(items)) = ps.get(1) else { return None };
    Some(items.iter().filter_map(|p| if let Parameter::Ref(Name::Entity(id)) = p { Some(*id) } else { None }).collect())
}

/// The DATA section read one instance at a time, for when ruststep can't read the whole file: it fails on the
/// first instance it can't tokenize, such as one with an empty list `()`, which Part 21 allows. Returns the
/// instances it can read, and the ids of those it can't. None if there's no DATA section.
fn read_instances(text: &str) -> Option<(DataSection, Vec<u64>)> {
    let header_end = text.find("ENDSEC;")? + 7;
    let data = header_end + text[header_end..].find("DATA")?;
    let start = data + text[data..].find(';')? + 1;
    let end = start + text[start..].rfind("ENDSEC;")?;
    let (mut entities, mut unread) = (Vec::new(), Vec::new());
    for rec in split_instances(&text[start..end]) {
        match EntityInstance::from_str(&format!("{rec};")) {
            Ok(e) => entities.push(e),
            Err(_) => unread.push(rec.trim_start_matches('#').split(|c: char| !c.is_ascii_digit()).next().and_then(|n| n.parse().ok()).unwrap_or(0)),
        }
    }
    Some((DataSection { meta: vec![], entities }, unread))
}

/// Part 21 instances, split at the semicolons outside strings and comments.
fn split_instances(data: &str) -> Vec<&str> {
    let (b, mut out, mut start, mut i) = (data.as_bytes(), Vec::new(), 0, 0);
    let (mut string, mut comment) = (false, false);
    while i < b.len() {
        match b[i] {
            b'*' if comment && b.get(i + 1) == Some(&b'/') => { comment = false; i += 1; }
            _ if comment => {}
            b'\'' => string = !string,
            b'/' if !string && b.get(i + 1) == Some(&b'*') => { comment = true; i += 1; }
            b';' if !string => {
                let rec = data[start..i].trim();
                if !rec.is_empty() {
                    out.push(rec);
                }
                start = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    out
}

fn instance_id(e: &EntityInstance) -> u64 {
    match e {
        EntityInstance::Simple { id, .. } | EntityInstance::Complex { id, .. } => *id,
    }
}

fn partial<'a>(e: &'a EntityInstance, name: &str) -> Option<&'a [Parameter]> {
    let rec = match e {
        EntityInstance::Simple { record, .. } => (record.name == name).then_some(record)?,
        EntityInstance::Complex { subsuper, .. } => subsuper.0.iter().find(|r| r.name == name)?,
    };
    match &rec.parameter {
        Parameter::List(ps) => Some(ps),
        _ => None,
    }
}

fn ref_id(p: Option<&Parameter>) -> Option<u64> {
    match p? {
        Parameter::Ref(Name::Entity(id)) => Some(*id),
        _ => None,
    }
}

/// Radians per unit of a plane angle unit: 1 for the SI radian, a CONVERSION_BASED_UNIT's factor (degrees: pi/180).
fn angle_unit_factor(by_id: &HashMap<u64, &EntityInstance>, unit: u64) -> Option<f64> {
    let e = by_id.get(&unit)?;
    partial(e, "PLANE_ANGLE_UNIT")?;
    if let Some(cb) = partial(e, "CONVERSION_BASED_UNIT") {
        let m = by_id.get(&ref_id(cb.get(1))?)?;
        let ps = partial(m, "PLANE_ANGLE_MEASURE_WITH_UNIT").or_else(|| partial(m, "MEASURE_WITH_UNIT"))?;
        let value = match ps.first()? {
            Parameter::Typed { parameter, .. } => match **parameter {
                Parameter::Real(x) => x,
                Parameter::Integer(i) => i as f64,
                _ => return None,
            },
            Parameter::Real(x) => *x,
            _ => return None,
        };
        return Some(value * angle_unit_factor(by_id, ref_id(ps.get(1))?).unwrap_or(1.0));
    }
    partial(e, "SI_UNIT").map(|_| 1.0)
}

/// Radians per plane angle unit in the root representation's context, if it says.
fn angle_factor(entities: &[EntityInstance], root: u64) -> Option<f64> {
    let by_id: HashMap<u64, &EntityInstance> = entities.iter().map(|e| (instance_id(e), e)).collect();
    let rep = by_id.get(&root)?;
    let ps = match rep {
        EntityInstance::Simple { record, .. } => match &record.parameter {
            Parameter::List(ps) => ps.as_slice(),
            _ => return None,
        },
        EntityInstance::Complex { .. } => partial(rep, "REPRESENTATION")?,
    };
    let ctx = by_id.get(&ref_id(ps.get(2))?)?;
    let Some(Parameter::List(units)) = partial(ctx, "GLOBAL_UNIT_ASSIGNED_CONTEXT")?.first() else { return None };
    units.iter().find_map(|u| angle_unit_factor(&by_id, ref_id(Some(u))?))
}

/// Convert each CONICAL_SURFACE's semi_angle to radians; returns how many were changed.
fn cone_angles(entities: &mut [EntityInstance], factor: f64) -> usize {
    if (factor - 1.0).abs() < 1e-15 {
        return 0;
    }
    let mut changed = 0;
    for e in entities.iter_mut() {
        let EntityInstance::Simple { record, .. } = e else { continue };
        if record.name != "CONICAL_SURFACE" {
            continue;
        }
        let Parameter::List(ps) = &mut record.parameter else { continue };
        if let Some(Parameter::Real(x)) = ps.get_mut(3) {
            *x *= factor;
            changed += 1;
        }
    }
    changed
}

/// Make each TOROIDAL_SURFACE's radii positive; returns how many were changed.
fn abs_torus_radii(entities: &mut [EntityInstance]) -> usize {
    let mut changed = 0;
    for e in entities.iter_mut() {
        let EntityInstance::Simple { record, .. } = e else { continue };
        if record.name != "TOROIDAL_SURFACE" {
            continue;
        }
        let Parameter::List(ps) = &mut record.parameter else { continue };
        let mut any = false;
        for p in ps.iter_mut().skip(2).take(2) {
            if let Parameter::Real(x) = p {
                if *x < 0.0 {
                    *x = -*x;
                    any = true;
                }
            }
        }
        changed += any as usize;
    }
    changed
}

/// Make each SURFACE_CURVE and SEAM_CURVE with a 3D curve use it (master_representation .CURVE_3D.); returns how
/// many were changed.
fn prefer_3d_curves(entities: &mut [EntityInstance]) -> usize {
    let mut changed = 0;
    for e in entities.iter_mut() {
        let EntityInstance::Simple { record, .. } = e else { continue };
        if record.name != "SURFACE_CURVE" && record.name != "SEAM_CURVE" {
            continue;
        }
        let Parameter::List(ps) = &mut record.parameter else { continue };
        if !matches!(ps.get(1), Some(Parameter::Ref(_))) {
            continue;
        }
        if let Some(m @ Parameter::Enumeration(_)) = ps.get_mut(3) {
            if *m != Parameter::Enumeration("CURVE_3D".into()) {
                *m = Parameter::Enumeration("CURVE_3D".into());
                changed += 1;
            }
        }
    }
    changed
}

/// Give each AXIS2_PLACEMENT_3D whose ref_direction is omitted and whose axis is ±x the ref_direction (0, 1, 0), a
/// DIRECTION added with a new id; returns how many were changed. (ISO 10303-42 `first_proj_axis`: (1, 0, 0) unless
/// the axis is ±(1, 0, 0), then (0, 1, 0). Here "is" allows rounding, which gives the same frame.)
fn fix_placements(entities: &mut Vec<EntityInstance>) -> usize {
    let mut along_x = std::collections::HashSet::new();
    for e in entities.iter() {
        let EntityInstance::Simple { id, record } = e else { continue };
        if record.name != "DIRECTION" {
            continue;
        }
        let Parameter::List(ps) = &record.parameter else { continue };
        let Some(Parameter::List(r)) = ps.get(1) else { continue };
        let v: Vec<f64> = r.iter().filter_map(|p| if let Parameter::Real(x) = p { Some(*x) } else { None }).collect();
        let n = v.iter().map(|x| x * x).sum::<f64>().sqrt();
        if v.len() == 3 && n > 0.0 && (v[0] / n).abs() > 1.0 - 1e-12 {
            along_x.insert(*id);
        }
    }
    let new_id = entities.iter().map(instance_id).max().unwrap_or(0) + 1;
    let mut fixed = 0;
    for e in entities.iter_mut() {
        let EntityInstance::Simple { record, .. } = e else { continue };
        if record.name != "AXIS2_PLACEMENT_3D" {
            continue;
        }
        let Parameter::List(ps) = &mut record.parameter else { continue };
        if let (Some(Parameter::Ref(Name::Entity(axis))), Some(r @ Parameter::NotProvided)) = (ps.get(2).cloned(), ps.get_mut(3)) {
            if along_x.contains(&axis) {
                *r = Parameter::Ref(Name::Entity(new_id));
                fixed += 1;
            }
        }
    }
    if fixed > 0 {
        let ratios = Parameter::List(vec![Parameter::Real(0.0), Parameter::Real(1.0), Parameter::Real(0.0)]);
        let record = truck_stepio::r#in::ruststep::ast::Record { name: "DIRECTION".into(), parameter: Parameter::List(vec![Parameter::String(String::new()), ratios]) };
        entities.push(EntityInstance::Simple { id: new_id, record });
    }
    fixed
}

// ---- meshing and output ----

#[derive(Default)]
struct Out {
    positions: Vec<f32>,
    normals: Vec<f32>,
    indices: Vec<u32>,
    faces: Vec<i32>,          // (entity id or -1, start, count) per face
    edge_positions: Vec<f32>, // all polylines
    edges: Vec<i32>,          // (entity id or -1, start, count, kind) per edge
    edge_angles: Vec<f32>,    // dihedral angle per edge, or -1
    diag: String,
}

const SHARED: i32 = 0;
const SEAM: i32 = 1;
const FREE: i32 = 2;
const DEGENERATE: i32 = 3;

fn id32(id: u64) -> i32 {
    i32::try_from(id).unwrap_or(-1)
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

/// Six times the volume a closed triangle mesh encloses: positive when its triangles face outward.
fn signed_volume6(polys: &[Option<PolygonMesh>]) -> f64 {
    let Some(r) = polys.iter().flatten().find_map(|p| p.positions().first().copied()) else { return 0.0 };
    let mut v = 0.0;
    for p in polys.iter().flatten() {
        let pos = p.positions();
        for tri in p.faces().triangle_iter() {
            let (a, b, c) = (pos[tri[0].pos] - r, pos[tri[1].pos] - r, pos[tri[2].pos] - r);
            v += a.dot(b.cross(c));
        }
    }
    v
}

#[allow(clippy::too_many_arguments)]
fn mesh_shell(b: &Built, id: u64, role: Role, tol: f64, origin: Point3, with_edges: bool, out: &mut Out, diag: &mut Diag) {
    let meshed = b.shell.robust_triangulation(tol);
    // Which faces use each edge (one entry per use).
    let mut uses: Vec<Vec<usize>> = vec![Vec::new(); meshed.edges.len()];
    for (k, face) in meshed.faces.iter().enumerate() {
        for e in face.boundaries.iter().flatten() {
            uses[e.index].push(k);
        }
    }
    // The face meshes, each facing the way its face does.
    let mut polys: Vec<Option<PolygonMesh>> = meshed
        .faces
        .iter()
        .map(|face| {
            face.surface.clone().map(|mut poly| {
                if !face.orientation {
                    poly.invert();
                }
                poly
            })
        })
        .collect();
    // A solid's shell must face out of the material: outward for the outer shell, into the void for a void. Checked
    // only when the mesh is closed (every face meshed and every edge used twice) and its faces agree (`consistent`):
    // a face truck orients against its neighbours would make the volume meaningless. (A face that didn't convert leaves
    // its neighbours' edges used once, unless what remains is closed anyway.)
    if role != Role::Surface {
        let closed = polys.iter().all(Option::is_some) && uses.iter().all(|u| u.len() == 2);
        if !closed {
            diag.unchecked_shells.push(id);
        } else if !consistent(&polys) {
            diag.inconsistent_shells.push(id);
        } else if (signed_volume6(&polys) < 0.0) == (role == Role::Outer) {
            polys.iter_mut().flatten().for_each(|p| p.invert());
            diag.reversed_shells.push((id, role == Role::Void));
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
        out.faces.extend([id32(fid), start as i32, (out.indices.len() - start) as i32]);
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
        out.edges.extend([id32(b.edge_ids[j]), start as i32, pts.len() as i32, kind]);
        out.edge_angles.push(angle);
    }
}

fn run(data: &[u8], root: u64, tol: f64, origin: Point3, with_edges: bool) -> Result<(Out, Diag), String> {
    let text = String::from_utf8_lossy(data);
    let mut diag = Diag::default();
    let mut section = match ruststep::parser::parse(&text) {
        Ok(mut ex) if !ex.data.is_empty() => ex.data.swap_remove(0),
        Ok(_) => return Err("no DATA section".into()),
        Err(e) => {
            let (section, unread) = read_instances(&text).ok_or_else(|| format!("STEP parse error: {e}"))?;
            diag.unread_instances = unread;
            section
        }
    };
    let section = &mut section;
    diag.fixed_placements = fix_placements(&mut section.entities);
    diag.curves_3d = prefer_3d_curves(&mut section.entities);
    diag.tori = abs_torus_radii(&mut section.entities);
    if let Some(f) = angle_factor(&section.entities, root) {
        diag.cones = cone_angles(&mut section.entities, f);
    }
    let section = &*section;
    let table = Table::from_data_section(section);
    let mut shells = Vec::new();
    if root != 0 {
        let e = section.entities.iter().find(|e| matches!(e, EntityInstance::Simple { id, .. } | EntityInstance::Complex { id, .. } if *id == root));
        let e = e.ok_or_else(|| format!("root #{root} not in the payload"))?;
        let items = root_items(e).ok_or_else(|| format!("root #{root} ({}) has no items", record_name(e)))?;
        for id in items {
            let name = section.entities.iter().find(|e| matches!(e, EntityInstance::Simple { id: i, .. } | EntityInstance::Complex { id: i, .. } if *i == id)).map(record_name).unwrap_or_default();
            item_shells(&table, id, &name, &mut diag, &mut shells);
        }
    } else {
        let mut ids: Vec<u64> = table.manifold_solid_brep.keys().chain(table.shell_based_surface_model.keys()).copied().collect();
        ids.sort();
        for id in ids {
            item_shells(&table, id, "", &mut diag, &mut shells);
        }
    }
    let mut out = Out::default();
    for (id, role) in shells {
        if let Some(b) = build_shell(&table, id, &mut diag) {
            mesh_shell(&b, id, role, tol, origin, with_edges, &mut out, &mut diag);
        } else {
            diag.skipped_items.push(format!("shell #{id}"));
        }
    }
    Ok((out, diag))
}

fn diag_json(d: &Diag) -> String {
    let mut m = serde_json::Map::new();
    m.insert("unconvertedFaces".into(), d.unconverted_faces.clone().into());
    m.insert("unconvertedEdges".into(), d.unconverted_edges.clone().into());
    m.insert("nonfiniteEdges".into(), d.nonfinite_edges.clone().into());
    m.insert("nonfiniteFaces".into(), d.nonfinite_faces.clone().into());
    m.insert("unreadInstances".into(), d.unread_instances.clone().into());
    m.insert("unmeshedFaces".into(), d.unmeshed_faces.clone().into());
    m.insert("skippedItems".into(), d.skipped_items.clone().into());
    m.insert("fixedPlacements".into(), d.fixed_placements.into());
    m.insert("curves3d".into(), d.curves_3d.into());
    m.insert("tori".into(), d.tori.into());
    m.insert("cones".into(), d.cones.into());
    m.insert("reversedShells".into(), d.reversed_shells.iter().map(|&(id, void)| serde_json::json!([id, void])).collect::<Vec<_>>().into());
    m.insert("uncheckedShells".into(), d.unchecked_shells.clone().into());
    m.insert("inconsistentShells".into(), d.inconsistent_shells.clone().into());
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

/// Tessellate `len` bytes at `ptr`; 0 on success, 1 on failure (the diagnostics say why).
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn tess_run(ptr: *const u8, len: usize, root: f64, tol: f64, ox: f64, oy: f64, oz: f64, edges: i32) -> i32 {
    let data = std::slice::from_raw_parts(ptr, len);
    let (out, rc) = match run(data, root as u64, tol, Point3::new(ox, oy, oz), edges != 0) {
        Ok((mut out, d)) => {
            out.diag = diag_json(&d);
            (out, 0)
        }
        Err(e) => (Out { diag: serde_json::json!({ "error": e }).to_string(), ..Out::default() }, 1),
    };
    RESULT.with(|r| *r.borrow_mut() = out);
    rc
}

/// The address of one result array: 0 positions, 1 normals (f32 × 3), 2 indices (u32), 3 faces (i32 × 3),
/// 4 edge positions (f32 × 3), 5 edges (i32 × 4), 6 edge angles (f32), 7 diagnostics (UTF-8 JSON).
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
