#[path = "../../../scripts/desktop-version-build.rs"]
mod desktop_version;

fn main() {
    desktop_version::DesktopVersion::emit("../../../package.json");
    let mut attributes = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_FEATURE")
        .is_ok_and(|features| features.split(',').any(|feature| feature == "crt-static"))
    {
        // Tauri's MSVC runtime override excludes the static UCRT that Rust selects.
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new().static_vc_runtime(false));
    }
    tauri_build::try_build(attributes).expect("failed to run Tauri build helpers");
}
