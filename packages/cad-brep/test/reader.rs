//! A reader of cad-brep buffers through cad_brep.rs, for header.test.ts: prints, per column, its element count, the
//! sum of its finite values and how many aren't finite, as reader.c does; exits 2 if `Brep::open` refuses the buffer.

#[path = "../include/cad_brep.rs"]
mod cad_brep;

fn main() {
    let path = std::env::args().nth(1).expect("a buffer's path");
    let buf = std::fs::read(path).expect("readable");
    let Ok(d) = cad_brep::Brep::open(&buf) else { std::process::exit(2) };
    for k in 0..cad_brep::COLUMN_COUNT {
        let xs = d.values(k);
        let sum = xs.iter().filter(|x| x.is_finite()).fold(0.0, |s, x| s + x);
        let bad = xs.iter().filter(|x| !x.is_finite()).count();
        println!("{k} {} {} {bad}", xs.len(), fmt17(sum));
    }
    // A typed accessor is its column, and kinds are as layout.ts numbers them.
    println!("edge.curve {}", d.edge_curve().iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","));
    println!("face.id {}", d.face_id().iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","));
    println!("kinds {} {} {} {}", cad_brep::curve_kind::OFFSET, cad_brep::surface_kind::FIXED_REFERENCE_SWEPT,
        cad_brep::item_kind::POINT, cad_brep::trim_preference::CARTESIAN);
}

/// Like C's %.17g, enough for the test to read the value back exactly.
fn fmt17(x: f64) -> String { format!("{x:e}") }
