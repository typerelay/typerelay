#[path = "../../../scripts/desktop-version-build.rs"]
mod desktop_version;

#[test]
fn root_desktop_version_is_semver() {
    for version in ["0.0.0", "1.3.5", "9.8.7", "1.2.3-beta.1+build.02"] {
        assert!(desktop_version::DesktopVersion::valid(version), "{version}");
    }
    for version in ["", "invalid", "1.2", "01.2.3", "1.2.3-01", "1.2.3..4", "1.2.3+", "1.2.3-", "1.2.3\n"] {
        assert!(!desktop_version::DesktopVersion::valid(version), "{version}");
    }
    let package: serde_json::Value = serde_json::from_str(include_str!("../../../package.json")).unwrap();
    assert_eq!(env!("TYPERELAY_VERSION"), package["version"].as_str().unwrap());
    desktop_version::DesktopVersion::emit("../../package.json");
}
