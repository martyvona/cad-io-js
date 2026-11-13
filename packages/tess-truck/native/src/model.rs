//! A part's cad-brep model (packages/cad-brep, read through the generated cad_brep.rs) as truck's shells. Each kind
//! truck has geometry for is built as truck-stepio builds it from STEP, from the model's rows (complete placements,
//! radians, positive radii: the model's rules), so it meshes as truck reading the model written as STEP did (until
//! that route was removed, checked over the corpus face by face); kinds truck has no geometry for (trimmed, composite
//! and offset curves, offset, trimmed and swept surfaces, vertex and poly loops, edges without vertices) leave their
//! faces out, reported. An edge with p-curves and no 3D curve is its first p-curve (by row) on that face's surface, as
//! truck-stepio reads a surface curve whose master is its first p-curve. Items other than solid and sheet bodies are
//! listed as skipped.

use crate::cad_brep::{self, body_kind, curve_kind, item_kind, orientation, surface_kind, Brep};
use crate::{clamp_curve, clamp_surface, finite_curve, finite_surface, Built, Diag, Role};
use std::collections::HashMap;
use std::f64::consts::PI;
use truck_geometry::prelude::{
    BSplineCurve, BSplineSurface, ExtrudedCurve, KnotVec, Line, NurbsCurve, NurbsSurface, Plane, Processor,
    RevolutedCurve, Torus, TrimmedCurve, UnitCircle, UnitHyperbola, UnitParabola,
};
use truck_meshalgo::prelude::*;
use truck_stepio::r#in::step_geometry::{
    self as sg, Conic2D, Conic3D, Curve2D, Curve3D, ElementarySurface, Surface, SweptCurve,
};
use truck_topology::compress::{CompressedEdge, CompressedEdgeIndex, CompressedFace, CompressedShell};

/// The model's pools at a row's offsets.
struct Pools<'a> {
    real: &'a [f64],
    int: &'a [i32],
}

impl<'a> Pools<'a> {
    fn reals(&self, at: i32, n: usize) -> Option<&'a [f64]> { self.real.get(at as usize..at as usize + n) }
    fn ints(&self, at: i32, n: usize) -> Option<&'a [i32]> { self.int.get(at as usize..at as usize + n) }
}

/// A 3D placement's 9 reals (origin, axis, x direction) as truck's frame: columns x, y = axis x x, axis, origin; x
/// made orthogonal to the axis again as truck-stepio makes it. The model's are orthonormal already, but only to
/// rounding, and truck's meshes follow the last bit (a tenth of bug30790.step's faces mesh otherwise).
fn frame(p: &[f64]) -> Matrix4 {
    let (o, z, x) = (Vector3::new(p[0], p[1], p[2]), Vector3::new(p[3], p[4], p[5]), Vector3::new(p[6], p[7], p[8]));
    let x = (x - x.dot(z) * z).normalize();
    Matrix4::from_cols(x.extend(0.0), z.cross(x).extend(0.0), z.extend(0.0), o.extend(1.0))
}

/// The model's id (0: none), as the diagnostics give ids.
fn id64(x: u32) -> u64 { x as u64 }

pub struct Model {
    d: Brep,
    /// Each edge's first p-curve (by row) and the surface of the face using it there.
    pcurves: HashMap<usize, (usize, usize)>,
}

impl Model {
    pub fn open(buf: &[u8]) -> Result<Model, String> {
        let d = Brep::open(buf)?;
        let mut pcurves: HashMap<usize, (usize, usize)> = HashMap::new();
        for f in 0..d.face_surface().len() {
            let first = d.face_first_loop()[f] as usize;
            for l in first..first + d.face_loop_count()[f] as usize {
                if d.loop_kind()[l] != cad_brep::loop_kind::EDGE {
                    continue;
                }
                let c0 = d.loop_first()[l] as usize;
                for c in c0..c0 + d.loop_count()[l] as usize {
                    let (e, pc) = (d.coedge_edge()[c] as usize, d.coedge_pcurve()[c]);
                    if pc < 0 {
                        continue;
                    }
                    let x = pcurves.entry(e).or_insert((pc as usize, d.face_surface()[f] as usize));
                    if (pc as usize) < x.0 {
                        *x = (pc as usize, d.face_surface()[f] as usize);
                    }
                }
            }
        }
        Ok(Model { d, pcurves })
    }

    fn curves(&self) -> Pools<'_> { Pools { real: self.d.pool_curve_real(), int: self.d.pool_curve_int() } }
    fn surfaces(&self) -> Pools<'_> { Pools { real: self.d.pool_surface_real(), int: self.d.pool_surface_int() } }

    fn point(&self, v: i32) -> Point3 {
        let p = &self.d.vertex_point()[3 * v as usize..3 * v as usize + 3];
        Point3::new(p[0], p[1], p[2])
    }

    /// A 3D B-spline curve's knots, poles and weights (if rational).
    fn bspline(&self, k: usize) -> Option<Curve3D> {
        let pools = self.curves();
        let (r, i) = (self.d.curve_real()[k], self.d.curve_int()[k]);
        let head = pools.ints(i, 7)?;
        let (n, nk, rational) = (head[1] as usize, head[2] as usize, head[3] != 0);
        let mults: Vec<usize> = pools.ints(i + 7, nk)?.iter().map(|&m| m as usize).collect();
        let reals = pools.reals(r, nk + 3 * n + if rational { n } else { 0 })?;
        let knots = KnotVec::from_single_multi(reals[..nk].to_vec(), mults).ok()?;
        let poles: Vec<Point3> =
            reals[nk..nk + 3 * n].chunks(3).map(|p| Point3::new(p[0], p[1], p[2])).collect();
        let b = BSplineCurve::try_new(knots, poles).ok()?;
        Some(if rational {
            Curve3D::NurbsCurve(NurbsCurve::try_from_bspline_and_weights(b, reals[nk + 3 * n..].to_vec()).ok()?)
        } else {
            Curve3D::BSplineCurve(b)
        })
    }

    /// A conic's frame scaled as truck-stepio scales it (the unit circle, hyperbola or parabola onto this one), and
    /// its kind.
    fn conic(&self, k: usize) -> Option<(Matrix4, u8)> {
        let kind = self.d.curve_kind()[k];
        let two = matches!(kind, curve_kind::ELLIPSE | curve_kind::HYPERBOLA);
        let r = self.curves().reals(self.d.curve_real()[k], if two { 11 } else { 10 })?;
        let m = frame(&r[..9]);
        let scale = match kind {
            curve_kind::CIRCLE => Matrix4::from_scale(r[9]),
            curve_kind::ELLIPSE | curve_kind::HYPERBOLA => Matrix4::from_nonuniform_scale(r[9], r[10], r[9].min(r[10])),
            curve_kind::PARABOLA => Matrix4::from_scale(r[9]),
            _ => return None,
        };
        Some((m * scale, kind))
    }

    /// A 3D curve whole, as truck-stepio converts a curve (a swept surface's): a line by its point and vector, a
    /// conic over its full range (the hyperbola's and parabola's from -1 to 1), a B-spline or polyline as it is.
    fn curve(&self, k: usize) -> Option<Curve3D> {
        if self.d.curve_dim()[k] != 3 {
            return None;
        }
        let kind = self.d.curve_kind()[k];
        Some(match kind {
            curve_kind::LINE => {
                let r = self.curves().reals(self.d.curve_real()[k], 7)?;
                let p = Point3::new(r[0], r[1], r[2]);
                Curve3D::Line(Line(p, p + Vector3::new(r[3], r[4], r[5]) * r[6]))
            }
            curve_kind::CIRCLE | curve_kind::ELLIPSE | curve_kind::HYPERBOLA | curve_kind::PARABOLA => {
                let (m, kind) = self.conic(k)?;
                Curve3D::Conic(match kind {
                    curve_kind::HYPERBOLA => {
                        Conic3D::Hyperbola(Processor::new(TrimmedCurve::new(UnitHyperbola::new(), (-1.0, 1.0)))
                            .transformed(m))
                    }
                    curve_kind::PARABOLA => {
                        Conic3D::Parabola(Processor::new(TrimmedCurve::new(UnitParabola::new(), (-1.0, 1.0)))
                            .transformed(m))
                    }
                    _ => Conic3D::Ellipse(Processor::new(TrimmedCurve::new(UnitCircle::new(), (0.0, 2.0 * PI)))
                        .transformed(m)),
                })
            }
            curve_kind::BSPLINE => self.bspline(k)?,
            curve_kind::POLYLINE => {
                let pools = self.curves();
                let n = *pools.ints(self.d.curve_int()[k], 1)?.first()? as usize;
                let r = pools.reals(self.d.curve_real()[k], 3 * n)?;
                Curve3D::Polyline(PolylineCurve(r.chunks(3).map(|p| Point3::new(p[0], p[1], p[2])).collect()))
            }
            _ => return None,
        })
    }

    /// An edge's curve between its vertices, as truck-stepio's `parse_curve3d` makes it: from `p` to `q` (the
    /// vertices in the curve's direction), a line between them, a conic trimmed at their nearest parameters (a closed
    /// one going round once), a B-spline or polyline as it is; then turned round if the edge runs against the curve.
    /// (The hyperbola isn't wrapped and the parabola is a parabola, where truck-stepio's own conversion of those two
    /// is wrong.)
    fn edge_curve(&self, k: usize, p: Point3, q: Point3, same_sense: bool) -> Option<Curve3D> {
        let (p, q) = if same_sense { (p, q) } else { (q, p) };
        let kind = self.d.curve_kind()[k];
        let mut c = match kind {
            curve_kind::LINE if self.d.curve_dim()[k] == 3 => Curve3D::Line(Line(p, q)),
            curve_kind::CIRCLE | curve_kind::ELLIPSE | curve_kind::HYPERBOLA | curve_kind::PARABOLA
                if self.d.curve_dim()[k] == 3 =>
            {
                let (m, kind) = self.conic(k)?;
                let inv = m.invert()?;
                let (a, b) = (inv.transform_point(p), inv.transform_point(q));
                Curve3D::Conic(match kind {
                    curve_kind::HYPERBOLA => {
                        let unit = UnitHyperbola::<Point3>::new();
                        let (u, v) =
                            (unit.search_nearest_parameter(a, None, 0)?, unit.search_nearest_parameter(b, None, 0)?);
                        Conic3D::Hyperbola(Processor::new(TrimmedCurve::new(unit, (u, v))).transformed(m))
                    }
                    curve_kind::PARABOLA => {
                        let unit = UnitParabola::<Point3>::new();
                        let (u, v) =
                            (unit.search_nearest_parameter(a, None, 0)?, unit.search_nearest_parameter(b, None, 0)?);
                        Conic3D::Parabola(Processor::new(TrimmedCurve::new(unit, (u, v))).transformed(m))
                    }
                    _ => {
                        let unit = UnitCircle::<Point3>::new();
                        let (u, mut v) =
                            (unit.search_nearest_parameter(a, None, 0)?, unit.search_nearest_parameter(b, None, 0)?);
                        if v <= u + TOLERANCE {
                            v += 2.0 * PI;
                        }
                        Conic3D::Ellipse(Processor::new(TrimmedCurve::new(unit, (u, v))).transformed(m))
                    }
                })
            }
            curve_kind::BSPLINE | curve_kind::POLYLINE => self.curve(k)?,
            _ => return None,
        };
        if !same_sense {
            c.invert();
        }
        Some(c)
    }

    /// A 2D placement's 4 reals (origin, x direction) as truck's frame: columns x, y (x turned +90 degrees), origin.
    fn frame2(p: &[f64]) -> Matrix3 {
        let x = Vector2::new(p[2], p[3]);
        Matrix3::from_cols(x.extend(0.0), Vector2::new(-x.y, x.x).extend(0.0), Vector2::new(p[0], p[1]).extend(1.0))
    }

    /// A p-curve between two points of its surface's parameters, as truck-stepio's `parse_curve2d` makes it: a line
    /// between their projections onto it, a conic trimmed at their nearest parameters (a closed one going round once),
    /// a B-spline or polyline as it is. (The parabola is a parabola, as in `edge_curve`.)
    fn curve2d_between(&self, k: usize, p: Point2, q: Point2) -> Option<Curve2D> {
        if self.d.curve_dim()[k] != 2 {
            return None;
        }
        let pools = self.curves();
        let (r, i) = (self.d.curve_real()[k], self.d.curve_int()[k]);
        Some(match self.d.curve_kind()[k] {
            curve_kind::LINE => {
                let x = pools.reals(r, 5)?;
                let a = Point2::new(x[0], x[1]);
                let line = Line(a, a + Vector2::new(x[2], x[3]) * x[4]);
                Curve2D::Line(Line(line.projection(p), line.projection(q)))
            }
            kind @ (curve_kind::CIRCLE | curve_kind::ELLIPSE | curve_kind::HYPERBOLA | curve_kind::PARABOLA) => {
                let two = matches!(kind, curve_kind::ELLIPSE | curve_kind::HYPERBOLA);
                let x = pools.reals(r, if two { 6 } else { 5 })?;
                let scale = if two { Matrix3::from_nonuniform_scale(x[4], x[5]) } else { Matrix3::from_scale(x[4]) };
                let m = Self::frame2(&x[..4]) * scale;
                let inv = m.invert()?;
                let (a, b) = (inv.transform_point(p), inv.transform_point(q));
                Curve2D::Conic(match kind {
                    curve_kind::HYPERBOLA => {
                        let unit = UnitHyperbola::<Point2>::new();
                        let (u, v) =
                            (unit.search_nearest_parameter(a, None, 0)?, unit.search_nearest_parameter(b, None, 0)?);
                        Conic2D::Hyperbola(Processor::new(TrimmedCurve::new(unit, (u, v))).transformed(m))
                    }
                    curve_kind::PARABOLA => {
                        let unit = UnitParabola::<Point2>::new();
                        let (u, v) =
                            (unit.search_nearest_parameter(a, None, 0)?, unit.search_nearest_parameter(b, None, 0)?);
                        Conic2D::Parabola(Processor::new(TrimmedCurve::new(unit, (u, v))).transformed(m))
                    }
                    _ => {
                        let unit = UnitCircle::<Point2>::new();
                        let (u, mut v) =
                            (unit.search_nearest_parameter(a, None, 0)?, unit.search_nearest_parameter(b, None, 0)?);
                        if v <= u + TOLERANCE {
                            v += 2.0 * PI;
                        }
                        Conic2D::Ellipse(Processor::new(TrimmedCurve::new(unit, (u, v))).transformed(m))
                    }
                })
            }
            curve_kind::BSPLINE => {
                let head = pools.ints(i, 7)?;
                let (n, nk, rational) = (head[1] as usize, head[2] as usize, head[3] != 0);
                let mults: Vec<usize> = pools.ints(i + 7, nk)?.iter().map(|&m| m as usize).collect();
                let reals = pools.reals(r, nk + 2 * n + if rational { n } else { 0 })?;
                let knots = KnotVec::from_single_multi(reals[..nk].to_vec(), mults).ok()?;
                let poles: Vec<Point2> = reals[nk..nk + 2 * n].chunks(2).map(|p| Point2::new(p[0], p[1])).collect();
                let b = BSplineCurve::try_new(knots, poles).ok()?;
                if rational {
                    Curve2D::NurbsCurve(NurbsCurve::try_from_bspline_and_weights(b, reals[nk + 2 * n..].to_vec()).ok()?)
                } else {
                    Curve2D::BSplineCurve(b)
                }
            }
            curve_kind::POLYLINE => {
                let n = *pools.ints(i, 1)?.first()? as usize;
                let x = pools.reals(r, 2 * n)?;
                Curve2D::Polyline(PolylineCurve(x.chunks(2).map(|p| Point2::new(p[0], p[1])).collect()))
            }
            _ => return None,
        })
    }

    /// An edge with p-curves and no 3D curve, from `p` to `q`: its first p-curve between their parameters on its
    /// surface, as truck-stepio reads a surface curve whose master is that p-curve (none where p and q coincide, where
    /// truck-stepio takes the absent 3D curve).
    fn pcurve_edge(&self, e: usize, p: Point3, q: Point3, same_sense: bool) -> Option<Curve3D> {
        let (pc, si) = *self.pcurves.get(&e)?;
        let (p, q) = if same_sense { (p, q) } else { (q, p) };
        if p.near(&q) {
            return None;
        }
        let surface = self.surface(si)?;
        let (a, b) = (surface.search_nearest_parameter(p, None, 100)?, surface.search_nearest_parameter(q, None, 100)?);
        let c2 = self.curve2d_between(pc, Point2::new(a.0, a.1), Point2::new(b.0, b.1))?;
        let mut c = Curve3D::PCurve(sg::PCurve::new(Box::new(c2), Box::new(surface)));
        if !same_sense {
            c.invert();
        }
        Some(c)
    }

    /// A surface as truck-stepio converts it from STEP.
    fn surface(&self, k: usize) -> Option<Surface> {
        let pools = self.surfaces();
        let (r, i) = (self.d.surface_real()[k], self.d.surface_int()[k]);
        let elementary = |x: ElementarySurface| Some(Surface::ElementarySurface(x));
        match self.d.surface_kind()[k] {
            surface_kind::PLANE => {
                let m = frame(pools.reals(r, 9)?);
                let o = Point3::from_homogeneous(m[3]);
                elementary(ElementarySurface::Plane(Plane::new(o, o + m[0].truncate(), o + m[1].truncate())))
            }
            surface_kind::SPHERE => {
                let x = pools.reals(r, 10)?;
                let sphere = sg::Sphere(truck_geometry::prelude::Sphere::new(Point3::origin(), x[9]));
                elementary(ElementarySurface::Sphere(Processor::new(sphere).transformed(frame(&x[..9]))))
            }
            surface_kind::CYLINDER => {
                let x = pools.reals(r, 10)?;
                let m = frame(&x[..9]);
                let (ax, az, c) = (m[0].truncate(), m[2].truncate(), Point3::from_homogeneous(m[3]));
                let p = c + ax * x[9];
                let mut s = Processor::new(RevolutedCurve::by_revolution(Line(p, p + az), c, az));
                s.invert();
                elementary(ElementarySurface::CylindricalSurface(s))
            }
            surface_kind::CONE => {
                let x = pools.reals(r, 11)?;
                let p = Point3::new(x[9], 0.0, 0.0);
                let v = Vector3::new(x[10].tan(), 0.0, 1.0);
                let mut s =
                    Processor::new(RevolutedCurve::by_revolution(Line(p, p + v), Point3::origin(), Vector3::unit_z()));
                s.transform_by(frame(&x[..9]));
                s.invert();
                elementary(ElementarySurface::ConicalSurface(s))
            }
            surface_kind::TORUS => {
                let x = pools.reals(r, 11)?;
                let torus = Torus::new(Point3::origin(), x[9], x[10]);
                elementary(ElementarySurface::ToroidalSurface(Processor::new(torus).transformed(frame(&x[..9]))))
            }
            surface_kind::BSPLINE => {
                let h = pools.ints(i, 11)?;
                let (nu, nv, ku, kv) = (h[2] as usize, h[3] as usize, h[4] as usize, h[5] as usize);
                let rational = h[6] != 0;
                let um = pools.ints(i + 11, ku)?.iter().map(|&m| m as usize).collect();
                let vm = pools.ints(i + 11 + ku as i32, kv)?.iter().map(|&m| m as usize).collect();
                let x = pools.reals(r, ku + kv + 3 * nu * nv + if rational { nu * nv } else { 0 })?;
                let uk = KnotVec::from_single_multi(x[..ku].to_vec(), um).ok()?;
                let vk = KnotVec::from_single_multi(x[ku..ku + kv].to_vec(), vm).ok()?;
                let poles = &x[ku + kv..ku + kv + 3 * nu * nv];
                let pole = |j: usize| Point3::new(poles[3 * j], poles[3 * j + 1], poles[3 * j + 2]);
                let pts: Vec<Vec<Point3>> = (0..nu).map(|a| (0..nv).map(|b| pole(a * nv + b)).collect()).collect();
                let b = BSplineSurface::try_new((uk, vk), pts).ok()?;
                Some(if rational {
                    let w = &x[ku + kv + 3 * nu * nv..];
                    let weights = (0..nu).map(|a| w[a * nv..(a + 1) * nv].to_vec()).collect();
                    Surface::NurbsSurface(NurbsSurface::try_from_bspline_and_weights(b, weights).ok()?)
                } else {
                    Surface::BSplineSurface(b)
                })
            }
            surface_kind::EXTRUSION => {
                let x = pools.reals(r, 4)?;
                let curve = self.curve(*pools.ints(i, 1)?.first()? as usize)?;
                let v = Vector3::new(x[0], x[1], x[2]) * x[3];
                Some(Surface::SweptCurve(SweptCurve::ExtrudedCurve(ExtrudedCurve::by_extrusion(curve, v))))
            }
            surface_kind::REVOLUTION => {
                let x = pools.reals(r, 6)?;
                let curve = self.curve(*pools.ints(i, 1)?.first()? as usize)?;
                let axis = Vector3::new(x[3], x[4], x[5]).normalize();
                let mut s = Processor::new(RevolutedCurve::by_revolution(curve, Point3::new(x[0], x[1], x[2]), axis));
                s.invert();
                Some(Surface::SweptCurve(SweptCurve::RevolutedCurve(s)))
            }
            _ => None,
        }
    }

    /// The shells of the model's items, by their roles; other items listed as skipped.
    pub fn shells(&self, diag: &mut Diag) -> Vec<(usize, Role)> {
        let d = &self.d;
        let mut out = Vec::new();
        for k in 0..d.item_kind().len() {
            let (kind, r, id) = (d.item_kind()[k], d.item_ref()[k], d.item_id()[k]);
            let what = match kind {
                item_kind::BODY => {
                    let b = r as usize;
                    let (first, count) = (d.body_first()[b] as usize, d.body_count()[b] as usize);
                    match d.body_kind()[b] {
                        body_kind::SOLID => {
                            for (j, m) in (first..first + count).enumerate() {
                                out.push((m, if j == 0 { Role::Outer } else { Role::Void }));
                            }
                            continue;
                        }
                        body_kind::SHEET => {
                            out.extend((first..first + count).map(|m| (m, Role::Surface)));
                            continue;
                        }
                        _ => "a wire body",
                    }
                }
                item_kind::CURVE => "a curve",
                item_kind::SURFACE => "a surface",
                item_kind::FACE => "a face",
                item_kind::POINT => "a point",
                _ => "an item of another kind",
            };
            diag.skipped_items.push(format!("{what} #{id}"));
        }
        out
    }

    /// The shell a body member uses, built: its faces (each once per use, turned as the use and the member say),
    /// edges and vertices shared within it.
    pub fn build_shell(&self, member: usize, diag: &mut Diag) -> (Built, u64) {
        let d = &self.d;
        let (s, flip) = (d.member_ref()[member] as usize, d.member_sense()[member] == 0);
        let empty = CompressedShell { vertices: vec![], edges: vec![], faces: vec![] };
        let mut b = Builder { m: self, out: Built { shell: empty, face_ids: vec![], edge_ids: vec![] },
            vertices: HashMap::new(), edges: HashMap::new() };
        let first = d.shell_first()[s] as usize;
        for u in first..first + d.shell_count()[s] as usize {
            b.face(d.face_use_face()[u] as usize, (d.face_use_sense()[u] == 0) != flip, diag);
        }
        (b.out, id64(d.shell_id()[s]))
    }
}

struct Builder<'a> {
    m: &'a Model,
    out: Built,
    vertices: HashMap<i32, usize>,
    edges: HashMap<usize, Option<usize>>,
}

impl Builder<'_> {
    fn vertex(&mut self, v: i32) -> usize {
        if let Some(&k) = self.vertices.get(&v) {
            return k;
        }
        self.out.shell.vertices.push(self.m.point(v));
        let k = self.out.shell.vertices.len() - 1;
        self.vertices.insert(v, k);
        k
    }

    fn edge(&mut self, e: usize, diag: &mut Diag) -> Option<usize> {
        if let Some(&k) = self.edges.get(&e) {
            return k;
        }
        let d = &self.m.d;
        let id = id64(d.edge_id()[e]);
        let k = (|| {
            let (c, a, b) = (d.edge_curve()[e], d.edge_start()[e], d.edge_end()[e]);
            if a < 0 || b < 0 {
                return None;
            }
            let same = d.edge_same_sense()[e] != 0;
            let (pa, pb) = (self.m.point(a), self.m.point(b));
            let mut curve =
                if c < 0 { self.m.pcurve_edge(e, pa, pb, same)? } else { self.m.edge_curve(c as usize, pa, pb, same)? };
            diag.clamped_edges += clamp_curve(&mut curve) as usize;
            if !finite_curve(&curve) {
                diag.nonfinite_edges.push(id);
                return None;
            }
            let vertices = (self.vertex(a), self.vertex(b));
            self.out.shell.edges.push(CompressedEdge { vertices, curve });
            self.out.edge_ids.push(id);
            Some(self.out.shell.edges.len() - 1)
        })();
        if k.is_none() && diag.nonfinite_edges.last() != Some(&id) {
            diag.unconverted_edges.push(id);
        }
        self.edges.insert(e, k);
        k
    }

    /// A face's loops as truck's boundaries (each edge loop's coedges in order, turned where the loop runs against
    /// its bound); None if a loop isn't an edge loop or an edge didn't convert.
    fn boundaries(&mut self, f: usize, diag: &mut Diag) -> Option<Vec<Vec<CompressedEdgeIndex>>> {
        let d = &self.m.d;
        let first = d.face_first_loop()[f] as usize;
        let mut out = Vec::new();
        for l in first..first + d.face_loop_count()[f] as usize {
            if d.loop_kind()[l] != cad_brep::loop_kind::EDGE {
                return None;
            }
            let sense = d.loop_sense()[l] != 0;
            let c0 = d.loop_first()[l] as usize;
            let mut wire = Vec::new();
            for c in c0..c0 + d.loop_count()[l] as usize {
                let index = self.edge(d.coedge_edge()[c] as usize, diag)?;
                let forward = d.coedge_orientation()[c] != orientation::REVERSED;
                wire.push(CompressedEdgeIndex { index, orientation: forward == sense });
            }
            if !sense {
                wire.reverse();
            }
            out.push(wire);
        }
        Some(out)
    }

    /// A face, used reversed if `reversed`.
    fn face(&mut self, f: usize, reversed: bool, diag: &mut Diag) {
        let d = &self.m.d;
        let id = id64(d.face_id()[f]);
        let surface = self.m.surface(d.face_surface()[f] as usize).map(|mut s| {
            diag.clamped_faces += clamp_surface(&mut s) as usize;
            if d.face_same_sense()[f] == 0 {
                s.invert();
            }
            s
        });
        if surface.as_ref().is_some_and(|s| !finite_surface(s)) {
            diag.nonfinite_faces.push(id);
            return;
        }
        match (surface, self.boundaries(f, diag)) {
            (Some(surface), Some(boundaries)) => {
                self.out.shell.faces.push(CompressedFace { surface, boundaries, orientation: !reversed });
                self.out.face_ids.push(id);
            }
            _ => diag.unconverted_faces.push(id),
        }
    }
}
