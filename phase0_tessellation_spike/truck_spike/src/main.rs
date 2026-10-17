//! Native driver: truck_spike <tol> <with_positions 0|1> <out_dir> files...
//! Writes <out_dir>/<basename>.truck.json per input; prints a timing line per file.
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let tol: f64 = args[1].parse().unwrap();
    let with_pos = args[2] == "1";
    let out_dir = &args[3];
    for f in &args[4..] {
        let bytes = std::fs::read(f).unwrap();
        // STEP is nominally ASCII; be lenient with stray bytes
        let s = String::from_utf8_lossy(&bytes);
        let t = Instant::now();
        let res = std::panic::catch_unwind(|| truck_spike::tessellate_all(&s, tol));
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let base = std::path::Path::new(f).file_name().unwrap().to_string_lossy();
        match res {
            Ok(Ok(shells)) => {
                let tris: usize = shells.iter().flat_map(|s| &s.faces).map(|f| f.positions.len() / 9).sum();
                let faces: usize = shells.iter().map(|s| s.faces.len()).sum();
                let cfs: usize = shells.iter().map(|s| s.cfs_faces).sum();
                let bad = shells.iter().filter(|s| !s.ok).count();
                println!("{base}\tok\t{ms:.0}ms\tshells={}\tfailedShells={bad}\tcfsFaces={cfs}\tfaces={faces}\ttris={tris}", shells.len());
                std::fs::write(format!("{out_dir}/{base}.truck.json"), truck_spike::to_json(&shells, with_pos)).unwrap();
            }
            Ok(Err(e)) => println!("{base}\terr\t{ms:.0}ms\t{e}"),
            Err(_) => println!("{base}\tpanic\t{ms:.0}ms"),
        }
    }
}
