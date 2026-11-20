//! A reader of cad-brep analysis buffers through cad_analysis.rs, for analysis.test.ts, with cad_brep.rs beside it:
//! prints, per column, its element count, the sum of its finite values and how many aren't finite, as
//! reader_analysis.c does, then typed accessors' values and the constants; exits 2 if `Analysis::open` refuses the
//! buffer.

#[path = "../include/cad_analysis.rs"]
mod cad_analysis;
#[path = "../include/cad_brep.rs"]
mod cad_brep;

fn main() {
    let path = std::env::args().nth(1).expect("a buffer's path");
    let buf = std::fs::read(path).expect("readable");
    let Ok(a) = cad_analysis::Analysis::open(&buf) else { std::process::exit(2) };
    for k in 0..cad_analysis::COLUMN_COUNT {
        let xs = a.values(k);
        let sum = xs.iter().filter(|x| x.is_finite()).fold(0.0, |s, x| s + x);
        let bad = xs.iter().filter(|x| !x.is_finite()).count();
        println!("{k} {} {:e} {bad}", xs.len(), sum);
    }
    // A typed accessor is its column, and the constants are as analysis-layout.ts numbers them.
    let words = a.analysis_model().iter().map(|w| format!("{w:08x}")).collect::<Vec<_>>();
    println!("model {}", words.join(" "));
    println!("coedge.face {}", a.coedge_face().iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","));
    println!("kinds {} {} {} {} {} {} {} {}", cad_analysis::provenance::HEALED, cad_analysis::measure_trust::EXACT,
        cad_analysis::continuity::G2, cad_analysis::singularity::NORMAL_VANISHES, cad_analysis::facing::IN,
        cad_analysis::facing_from::BOTH, cad_analysis::logical::UNKNOWN, cad_brep::COLUMN_COUNT);
}
