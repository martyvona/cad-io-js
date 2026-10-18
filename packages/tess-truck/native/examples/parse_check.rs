// Which instances of a payload ruststep can't tokenize: cargo run --release --example parse_check -- <payload.stp>
use std::str::FromStr;
use truck_stepio::r#in::ruststep::ast::EntityInstance;
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let text = String::from_utf8_lossy(&std::fs::read(&a[1]).unwrap()).into_owned();
    let data = &text[text.find("DATA;").unwrap() + 5..text.rfind("ENDSEC;").unwrap()];
    let mut bad = 0;
    for rec in data.split(";\n").map(str::trim).filter(|r| !r.is_empty()) {
        if EntityInstance::from_str(&format!("{rec};")).is_err() {
            bad += 1;
            if bad <= 5 { println!("{}", &rec[..rec.len().min(160)]); }
        }
    }
    println!("{bad} instances fail");
}
