use std::{env, fs, path::Path};

pub struct DesktopVersion;

impl DesktopVersion {
    pub fn valid(version: &str) -> bool {
        let (release, metadata) = version.split_once('+').map_or((version, None), |(release, metadata)| (release, Some(metadata)));
        let (core, prerelease) = release.split_once('-').map_or((release, None), |(core, prerelease)| (core, Some(prerelease)));
        let numeric = |value: &str| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) && (value == "0" || !value.starts_with('0'));
        let identifiers = |value: &str, prerelease: bool| value.split('.').all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') && (!prerelease || !part.bytes().all(|byte| byte.is_ascii_digit()) || numeric(part)));
        core.split('.').count() == 3 && core.split('.').all(numeric) && metadata.is_none_or(|value| identifiers(value, false)) && prerelease.is_none_or(|value| identifiers(value, true))
    }

    pub fn emit(package_path: &str) {
        let package = Path::new(&env::var("CARGO_MANIFEST_DIR").expect("Cargo manifest directory")).join(package_path);
        let contents = fs::read_to_string(&package).expect("root package.json");
        let json: serde_json::Value = serde_json::from_str(&contents).expect("valid root package.json");
        let version = json["version"].as_str().expect("root package.json version");
        assert!(Self::valid(version), "invalid root package version");
        println!("cargo:rerun-if-changed={}", package.display());
        println!("cargo:rustc-env=TYPERELAY_VERSION={version}");
    }
}
