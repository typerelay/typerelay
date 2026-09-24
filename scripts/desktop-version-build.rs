use std::{env, fs, path::Path};

pub struct DesktopVersion;

impl DesktopVersion {
    pub fn emit(package_path: &str) {
        let package = Path::new(&env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory")).join(package_path);
        let contents = fs::read_to_string(&package).expect("desktop package.json");
        let json: serde_json::Value = serde_json::from_str(&contents).expect("valid desktop package.json");
        let version = json["version"].as_str().expect("desktop package.json version");
        assert!(!version.is_empty() && version.chars().all(|character| character.is_ascii_alphanumeric() || ".+-".contains(character)), "invalid desktop package version");
        println!("cargo:rerun-if-changed={}", package.display());
        println!("cargo:rustc-env=TYPERELAY_VERSION={version}");
    }
}
