//! Phase 0 spike: tessellate every shell in a STEP (subset) string with truck, reporting the source face entity id
//! of each face's triangle range. Not production code.
use std::fmt::Write;
use truck_meshalgo::prelude::*;
use truck_stepio::r#in::ruststep::ast::Name;
use truck_stepio::r#in::ruststep::tables::{IntoOwned, PlaceHolder};
use truck_stepio::r#in::{step_geometry::Surface, ShellHolder, Table};
use wasm_bindgen::prelude::*;

/// Ids of the faces that truck's `shell_faces` keeps, in its output order (mirrors its `filter_map` conditions).
fn surviving_face_ids(table: &Table, shell: &ShellHolder) -> Vec<Option<u64>> {
    shell
        .cfs_faces
        .iter()
        .filter_map(|ph| {
            let PlaceHolder::Ref(Name::Entity(id)) = ph else { return None };
            let face = if let Some(f) = table.face_surface.get(id) {
                f.clone()
            } else {
                let of = table.oriented_face.get(id)?;
                let PlaceHolder::Ref(Name::Entity(fid)) = &of.face_element else { return None };
                table.face_surface.get(fid)?.clone()
            };
            let s = face.face_geometry.clone().into_owned(table).ok()?;
            Surface::try_from(&s).ok()?;
            Some(Some(*id))
        })
        .collect()
}

pub struct FaceOut {
    pub id: Option<u64>,
    pub positions: Vec<f64>, // flat xyz, unindexed (3 vertices per triangle)
}
pub struct ShellOut {
    pub id: u64,
    pub ok: bool,
    pub cfs_faces: usize,
    pub faces: Vec<FaceOut>,
    pub err: String,
}

pub fn tessellate_all(step: &str, tol: f64) -> Result<Vec<ShellOut>, String> {
    let table = Table::from_step(step).ok_or("Table::from_step failed")?;
    let mut ids: Vec<u64> = table.shell.keys().copied().collect();
    ids.sort();
    let mut out = Vec::new();
    for id in ids {
        let sh = &table.shell[&id];
        let mut so = ShellOut { id, ok: false, cfs_faces: sh.cfs_faces.len(), faces: vec![], err: String::new() };
        let cshell = match table.to_compressed_shell(sh) {
            Ok(c) => c,
            Err(e) => {
                so.err = format!("{e}");
                out.push(so);
                continue;
            }
        };
        let fids = surviving_face_ids(&table, sh);
        let fids = if fids.len() == cshell.faces.len() { fids } else { vec![None; cshell.faces.len()] };
        let meshed = cshell.robust_triangulation(tol);
        for (face, fid) in meshed.faces.iter().zip(fids) {
            let mut positions = Vec::new();
            if let Some(poly) = &face.surface {
                let mut poly = poly.clone();
                if !face.orientation {
                    poly.invert();
                }
                let p = poly.positions();
                for tri in poly.faces().triangle_iter() {
                    for v in tri {
                        let q = p[v.pos];
                        positions.extend_from_slice(&[q.x, q.y, q.z]);
                    }
                }
            }
            so.faces.push(FaceOut { id: fid, positions });
        }
        so.ok = true;
        out.push(so);
    }
    Ok(out)
}

/// JSON result: {shells:[{id, ok, cfsFaces, err, faces:[{id, tris, positions?}]}]}
pub fn to_json(shells: &[ShellOut], with_positions: bool) -> String {
    let mut s = String::from("{\"shells\":[");
    for (i, sh) in shells.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        write!(s, "{{\"id\":{},\"ok\":{},\"cfsFaces\":{},\"err\":{},\"faces\":[", sh.id, sh.ok, sh.cfs_faces, serde_json::to_string(&sh.err).unwrap()).unwrap();
        for (j, f) in sh.faces.iter().enumerate() {
            if j > 0 {
                s.push(',');
            }
            let id = f.id.map_or("null".to_string(), |x| x.to_string());
            write!(s, "{{\"id\":{},\"tris\":{}", id, f.positions.len() / 9).unwrap();
            if with_positions {
                s.push_str(",\"positions\":");
                s.push_str(&serde_json::to_string(&f.positions).unwrap());
            }
            s.push('}');
        }
        s.push_str("]}");
    }
    s.push_str("]}");
    s
}

#[wasm_bindgen]
pub fn tessellate(step: &str, tol: f64, with_positions: bool) -> String {
    match tessellate_all(step, tol) {
        Ok(shells) => to_json(&shells, with_positions),
        Err(e) => format!("{{\"error\":{}}}", serde_json::to_string(&e).unwrap()),
    }
}
