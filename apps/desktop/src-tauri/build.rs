#[path = "../../../scripts/desktop-version-build.rs"]
mod desktop_version;

fn main() {
    desktop_version::DesktopVersion::emit("../package.json");
    tauri_build::build();
}
