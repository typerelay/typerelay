use std::io::{Read, Write};
fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    if arguments.len() != 3 { std::process::exit(2); }
    let mut request = String::new();
    if std::io::stdin().take(12 * 1048576 + 1).read_to_string(&mut request).is_err() { std::process::exit(2); }
    let result = typerelay_mobile::Mobile::call(&arguments[1], &arguments[2], &request);
    let _ = std::io::stdout().write_all(result.as_bytes());
}
