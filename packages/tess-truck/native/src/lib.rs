//! The truck tessellation backend: a STEP subset in, the faces and edges of one shape representation out, with
//! their STEP entity ids, as flat arrays in linear memory that ../src/index.ts reads. A plain C ABI (no wasm-bindgen).
//!
//! Workarounds for truck (see CLAUDE.md, "truck"; truck itself is used unchanged):
//! - Shells are built here rather than by `Table::to_compressed_shell`. truck numbers a vertex or edge before
//!   converting it, so one that fails to convert shifts every later index, and it drops faces it can't convert
//!   without saying which. Here each face and edge keeps its STEP id, and a face whose surface or edges don't
//!   convert is left out and reported.
//! - An AXIS2_PLACEMENT_3D without a ref_direction whose axis is +/-x gets the ref_direction (0, 1, 0), as ISO
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
//! - A B-spline curve or surface with an unclamped knot vector is clamped: its valid range is the inner one, between
//!   its p-th knots from either end, but truck evaluates it over the whole knot vector, which yields NaN at the ends.
//! - An edge whose curve evaluates to non-finite points is left out, with its faces: truck would subdivide it until
//!   memory runs out.
//! - A solid's shell that faces the wrong way is reversed, as OCCT's shape healing (ShapeFix_Solid) does: an outer
//!   shell whose closed mesh encloses a negative signed volume, or a void whose mesh encloses a positive one. Some
//!   writers reverse voids twice (CLAUDE.md, "STEP files in the wild").
//! - A face whose mesh runs against all of its loops is reversed: ISO 10303-42 orients a face's loops
//!   counter-clockwise about its normal, but truck sometimes meshes a face inside out.

use std::cell::RefCell;
use std::collections::HashMap;
use truck_geometry::prelude::{BSplineCurve, BSplineSurface, KnotVec, NurbsCurve, NurbsSurface};
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
    /// Solid shells whose mesh's volume is too small or too uncertain to tell their orientation (see `volume_sign`).
    unclear_shells: Vec<u64>,
    /// CONICAL_SURFACEs whose semi_angle was converted to radians.
    cones: usize,
    /// TOROIDAL_SURFACEs whose negative radii were made positive.
    tori: usize,
    /// SURFACE_CURVEs and SEAM_CURVEs switched from a pcurve to their 3D curve (see the module comment).
    curves_3d: usize,
    /// AXIS2_PLACEMENT_3Ds given the standard's default ref_direction (see the module comment).
    fixed_placements: usize,
    /// Edges and faces whose B-spline curves or surfaces were clamped (see `clamp_curve`).
    clamped_edges: usize,
    clamped_faces: usize,
    /// Faces whose meshes ran against all their loops, reversed (see `loop_sense`).
    flipped_faces: Vec<u64>,
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

/// The clamped form of an unclamped knot vector of degree `p`, given that its valid range's ends `lo` and `hi` (its
/// p-th knots from either end) have multiplicity at least p, which knot insertion gives without changing the curve:
/// the knots from just before the last p copies of `lo` to just after the first p copies of `hi`, the outer two set
/// to `lo` and `hi`, and the range of control points they keep. The control points outside that range only shape
/// the curve outside its valid range, and the basis functions over the valid range don't depend on the outer two
/// knots' values.
fn clamped_knots(k: &KnotVec, p: usize, lo: f64, hi: f64) -> Option<(KnotVec, std::ops::Range<usize>)> {
    let s = (k.iter().rposition(|&t| t == lo)? + 1).checked_sub(p)?.checked_sub(1)?;
    let f = k.iter().position(|&t| t == hi)?;
    let mut knots = k.as_slice().get(s..=f + p)?.to_vec();
    knots[0] = lo;
    *knots.last_mut()? = hi;
    Some((KnotVec::from(knots), s..f))
}

/// The valid range of a knot vector of degree `p`, if it's unclamped and the range isn't empty.
fn unclamped_range(k: &KnotVec, p: usize) -> Option<(f64, f64)> {
    if p == 0 || k.is_clamped(p) || k.len() < 2 * p + 2 {
        return None;
    }
    let (lo, hi) = (k[p], k[k.len() - 1 - p]);
    (lo < hi).then_some((lo, hi))
}

fn count(k: &KnotVec, x: f64) -> usize {
    k.iter().filter(|&&t| t == x).count()
}

/// A B-spline curve clamped (see `clamped_knots`), or None if it's clamped already.
fn clamp_bspline<P: truck_geometry::base::control_point::ControlPoint<f64> + Tolerance>(
    c: &BSplineCurve<P>,
) -> Option<BSplineCurve<P>> {
    let p = c.degree();
    let (lo, hi) = unclamped_range(c.knot_vec(), p)?;
    let mut c = c.clone();
    while count(c.knot_vec(), lo) < p {
        c.add_knot(lo);
    }
    while count(c.knot_vec(), hi) < p {
        c.add_knot(hi);
    }
    let (knots, keep) = clamped_knots(c.knot_vec(), p, lo, hi)?;
    BSplineCurve::try_new(knots, c.control_points()[keep].to_vec()).ok()
}

/// A B-spline surface clamped in u and v, or None if it's clamped already.
fn clamp_bspline_surface<P: truck_geometry::base::control_point::ControlPoint<f64> + Tolerance>(
    s: &BSplineSurface<P>,
) -> Option<BSplineSurface<P>> {
    let (pu, pv) = (s.udegree(), s.vdegree());
    let (ur, vr) = (unclamped_range(s.uknot_vec(), pu), unclamped_range(s.vknot_vec(), pv));
    if ur.is_none() && vr.is_none() {
        return None;
    }
    let mut s = s.clone();
    let mut uknots = s.uknot_vec().clone();
    let mut vknots = s.vknot_vec().clone();
    let mut keep_u = 0..s.control_points().len();
    let mut keep_v = 0..s.control_points()[0].len();
    if let Some((lo, hi)) = ur {
        while count(s.uknot_vec(), lo) < pu {
            s.add_uknot(lo);
        }
        while count(s.uknot_vec(), hi) < pu {
            s.add_uknot(hi);
        }
        (uknots, keep_u) = clamped_knots(s.uknot_vec(), pu, lo, hi)?;
    }
    if let Some((lo, hi)) = vr {
        while count(s.vknot_vec(), lo) < pv {
            s.add_vknot(lo);
        }
        while count(s.vknot_vec(), hi) < pv {
            s.add_vknot(hi);
        }
        (vknots, keep_v) = clamped_knots(s.vknot_vec(), pv, lo, hi)?;
    }
    let pts = s.control_points()[keep_u].iter().map(|row| row[keep_v.clone()].to_vec()).collect();
    BSplineSurface::try_new((uknots, vknots), pts).ok()
}

/// Clamp a curve that's an unclamped B-spline; returns whether it was one. truck evaluates a B-spline over its whole
/// knot vector, but an unclamped one is only valid between its p-th knots from either end (ISO 10303-42), and yields
/// NaN or garbage outside.
fn clamp_curve(c: &mut Curve3D) -> bool {
    let clamped = match c {
        Curve3D::BSplineCurve(b) => clamp_bspline(b).map(Curve3D::BSplineCurve),
        Curve3D::NurbsCurve(n) => clamp_bspline(n.non_rationalized()).map(|b| Curve3D::NurbsCurve(NurbsCurve::new(b))),
        _ => None,
    };
    clamped.map(|x| *c = x).is_some()
}

/// Clamp a surface that's an unclamped B-spline, as `clamp_curve`; returns whether it was one.
fn clamp_surface(s: &mut Surface) -> bool {
    let clamped = match s {
        Surface::BSplineSurface(b) => clamp_bspline_surface(b).map(Surface::BSplineSurface),
        Surface::NurbsSurface(n) => {
            clamp_bspline_surface(n.non_rationalized()).map(|b| Surface::NurbsSurface(NurbsSurface::new(b)))
        }
        _ => None,
    };
    clamped.map(|x| *s = x).is_some()
}

/// An ORIENTED_EDGE or EDGE_CURVE id -> the EDGE_CURVE id and the orientation.
fn edge_ref(t: &Table, id: u64) -> Option<(u64, bool)> {
    if let Some(oe) = t.oriented_edge.get(&id) {
        return Some((entity(&oe.edge_element)?, oe.orientation));
    }
    t.edge_curve.contains_key(&id).then_some((id, true))
}

/// An ORIENTED_FACE or FACE_SURFACE (ADVANCED_FACE) id -> the face's id, holder and orientation.
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
            let mut curve = EntityTable::<EdgeCurveHolder>::get_owned(self.t, id).ok()?.parse_curve3d().ok()?;
            diag.clamped_edges += clamp_curve(&mut curve) as usize;
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
            diag.clamped_faces += clamp_surface(&mut s) as usize;
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
    let out = Built { shell: empty, face_ids: vec![], edge_ids: vec![] };
    let mut b = ShellBuilder { t, out, vertices: HashMap::new(), edges: HashMap::new() };
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
        EntityInstance::Complex { subsuper, .. } => {
            subsuper.0.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join("+")
        }
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
            Err(_) => unread.push(
                rec.trim_start_matches('#')
                    .split(|c: char| !c.is_ascii_digit())
                    .next()
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(0),
            ),
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

/// Give each AXIS2_PLACEMENT_3D whose ref_direction is omitted and whose axis is +/-x the ref_direction (0, 1, 0), a
/// DIRECTION added with a new id; returns how many were changed. (ISO 10303-42 `first_proj_axis`: (1, 0, 0) unless
/// the axis is +/-(1, 0, 0), then (0, 1, 0). Here "is" allows rounding, which gives the same frame.)
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
        if let (Some(Parameter::Ref(Name::Entity(axis))), Some(r @ Parameter::NotProvided)) =
            (ps.get(2).cloned(), ps.get_mut(3))
        {
            if along_x.contains(&axis) {
                *r = Parameter::Ref(Name::Entity(new_id));
                fixed += 1;
            }
        }
    }
    if fixed > 0 {
        let ratios = Parameter::List(vec![Parameter::Real(0.0), Parameter::Real(1.0), Parameter::Real(0.0)]);
        let record = truck_stepio::r#in::ruststep::ast::Record {
            name: "DIRECTION".into(),
            parameter: Parameter::List(vec![Parameter::String(String::new()), ratios]),
        };
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
/// meshes wrongly, inside closed boundaries, outweighs the part's volume (CLAUDE.md, "truck", workaround 12).
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
        let e = section.entities.iter().find(|e| {
            matches!(e, EntityInstance::Simple { id, .. } | EntityInstance::Complex { id, .. } if *id == root)
        });
        let e = e.ok_or_else(|| format!("root #{root} not in the payload"))?;
        let items = root_items(e).ok_or_else(|| format!("root #{root} ({}) has no items", record_name(e)))?;
        for id in items {
            let name = section
                .entities
                .iter()
                .find(|e| {
                    matches!(
                        e,
                        EntityInstance::Simple { id: i, .. } | EntityInstance::Complex { id: i, .. } if *i == id
                    )
                })
                .map(record_name)
                .unwrap_or_default();
            item_shells(&table, id, &name, &mut diag, &mut shells);
        }
    } else {
        let mut ids: Vec<u64> =
            table.manifold_solid_brep.keys().chain(table.shell_based_surface_model.keys()).copied().collect();
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
    let reversed: Vec<_> = d.reversed_shells.iter().map(|&(id, void)| serde_json::json!([id, void])).collect();
    m.insert("reversedShells".into(), reversed.into());
    m.insert("uncheckedShells".into(), d.unchecked_shells.clone().into());
    m.insert("inconsistentShells".into(), d.inconsistent_shells.clone().into());
    m.insert("unclearShells".into(), d.unclear_shells.clone().into());
    m.insert("clampedEdges".into(), d.clamped_edges.into());
    m.insert("clampedFaces".into(), d.clamped_faces.into());
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

/// Tessellate `len` bytes at `ptr`; 0 on success, 1 on failure (the diagnostics say why).
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn tess_run(
    ptr: *const u8, len: usize, root: f64, tol: f64, ox: f64, oy: f64, oz: f64, edges: i32,
) -> i32 {
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

/// The address of one result array: 0 positions, 1 normals (f32 x 3), 2 indices (u32), 3 faces (i32 x 3),
/// 4 edge positions (f32 x 3), 5 edges (i32 x 4), 6 edge angles (f32), 7 diagnostics (UTF-8 JSON).
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

    // The rational quadratic circle of OCC22962-dm1-oc-214.stp #1742: knots (-1/3, 0, 0, ..., 1, 1, 4/3), valid on
    // [0, 1], and a cubic with uniform knots 0..=9, valid on [3, 6], which needs knots inserted at both ends.
    #[test]
    fn clamping_keeps_the_curve_over_its_valid_range() {
        let t = 1.0 / 3.0;
        let knots = KnotVec::from(vec![-t, 0.0, 0.0, t, t, 2.0 * t, 2.0 * t, 1.0, 1.0, 1.0 + t]);
        let pts: Vec<Vector4> = [
            (1.0, 0.0, 1.0), (0.5, 0.866, 0.5), (-0.5, 0.866, 1.0), (-1.0, 0.0, 0.5), (-0.5, -0.866, 1.0),
            (0.5, -0.866, 0.5), (1.0, 0.0, 1.0),
        ]
            .iter()
            .map(|&(x, y, w)| Vector4::new(x * w, y * w, 0.0, w))
            .collect();
        let cubic = BSplineCurve::new(
            KnotVec::from((0..10).map(f64::from).collect::<Vec<_>>()),
            (0..6).map(|i| Point3::new(i as f64, (i * i % 5) as f64, (i % 2) as f64)).collect(),
        );
        let circle = NurbsCurve::new(BSplineCurve::new(knots, pts));
        for (mut c, lo, hi) in [(Curve3D::NurbsCurve(circle), 0.0, 1.0), (Curve3D::BSplineCurve(cubic), 3.0, 6.0)] {
            let orig = c.clone();
            assert!(clamp_curve(&mut c));
            assert_eq!(c.range_tuple(), (lo, hi));
            for i in 0..=20 {
                let x = lo + (hi - lo) * i as f64 / 20.0;
                assert!(c.subs(x).distance(orig.subs(x)) < 1e-9, "at {x}: {:?} vs {:?}", c.subs(x), orig.subs(x));
            }
            assert!(!clamp_curve(&mut c));
        }
    }

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

    #[test]
    fn clamping_keeps_the_surface_over_its_valid_range() {
        let uk = KnotVec::from((0..8).map(f64::from).collect::<Vec<_>>());
        let vk = KnotVec::bezier_knot(1);
        let pts: Vec<Vec<Point3>> =
            (0..5).map(|i| (0..2).map(|j| Point3::new(i as f64, j as f64, ((i * 3) % 4) as f64)).collect()).collect();
        let mut s = Surface::BSplineSurface(BSplineSurface::new((uk, vk), pts));
        let orig = s.clone();
        assert!(clamp_surface(&mut s));
        assert_eq!(s.try_range_tuple(), (Some((2.0, 5.0)), Some((0.0, 1.0))));
        for i in 0..=12 {
            for j in 0..=4 {
                let (u, v) = (2.0 + 3.0 * i as f64 / 12.0, j as f64 / 4.0);
                assert!(s.subs(u, v).distance(orig.subs(u, v)) < 1e-9);
            }
        }
    }
}
