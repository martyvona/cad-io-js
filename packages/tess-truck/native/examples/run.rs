// Native run of the wrapper on one part's model, the bytes tess-truck's tessellate() sends (truck_occt.ts's DUMP writes
// them as .cad-brep), at its origin 0: prints the result code, triangles and diagnostics.
//   cargo run --release --example run -- <model.cad-brep> <tolerance mm>
fn main() {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 3 {
        eprintln!("usage: run <model.cad-brep> <tolerance mm>");
        std::process::exit(2);
    }
    let data = std::fs::read(&a[1]).unwrap();
    let tol: f64 = a[2].parse().unwrap();
    let rc = unsafe { tess_truck::tess_run_model(data.as_ptr(), data.len(), tol, 0.0, 0.0, 0.0, 1) };
    let diag = unsafe { std::slice::from_raw_parts(tess_truck::tess_ptr(7), tess_truck::tess_len(7)) };
    println!("rc {rc} triangles {} {}", tess_truck::tess_len(2) / 3, String::from_utf8_lossy(diag));
}
