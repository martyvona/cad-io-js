// Native run of the wrapper on one payload: cargo run --release --example run -- <payload.stp> <rootId> <tol>
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let data = std::fs::read(&a[1]).unwrap();
    let (root, tol): (f64, f64) = (a[2].parse().unwrap(), a[3].parse().unwrap());
    let rc = unsafe { tess_truck::tess_run(data.as_ptr(), data.len(), root, tol, 0.0, 0.0, 0.0, 1) };
    let diag = unsafe { std::slice::from_raw_parts(tess_truck::tess_ptr(7), tess_truck::tess_len(7)) };
    println!("rc {rc} triangles {} {}", tess_truck::tess_len(2) / 3, String::from_utf8_lossy(diag));
}
