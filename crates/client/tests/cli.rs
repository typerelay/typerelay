use std::{fs, process::Command};

#[test]
fn help_explains_commands_and_import_formats() {
    for (args, expected) in [
        (vec!["--help"], vec!["Synchronize now", "Upgrade legacy", "Import snippets"]),
        (vec!["import", "--help"], vec!["yaml", "bundle", "espanso"]),
        (vec!["migrate", "--help"], vec!["backed up", "--check", "does not import"]),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_typerelay")).args(args).output().unwrap();
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        assert!(!text.contains("proof of concept"));
        for expected in expected { assert!(text.contains(expected), "{text}"); }
    }
    let output = Command::new(env!("CARGO_BIN_EXE_typerelay")).arg("import").output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("espanso"));
}

#[test]
fn mutations_report_results_and_sync_errors_do_not_claim_success() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source.yml");
    let yaml = temp.path().join("converted.yml");
    let bundle = temp.path().join("library.typerelay.zip");
    fs::write(&source, "matches:\n- trigger: ':hello'\n  replace: Hello\n".replace("\n", "
")).unwrap();
    for (args, expected) in [
        (vec!["import", "espanso", source.to_str().unwrap(), yaml.to_str().unwrap()], "Imported"),
        (vec!["import", "yaml", yaml.to_str().unwrap(), "--name", "Example"], "Imported"),
        (vec!["export", "Example", bundle.to_str().unwrap()], "Exported"),
        (vec!["import", "bundle", bundle.to_str().unwrap(), "--name", "Copy"], "Imported"),
        (vec!["validate"], "Valid: 2 snippets"),
        (vec!["trash", "--empty", "--yes"], "Emptied"),
        (vec!["disconnect"], "Disconnected"),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_typerelay")).env("XDG_CONFIG_HOME", temp.path()).args(args).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains(expected), "{}", String::from_utf8_lossy(&output.stdout));
    }
    let output = Command::new(env!("CARGO_BIN_EXE_typerelay")).env("XDG_CONFIG_HOME", temp.path()).arg("sync").output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Connect first"));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("Synced"));
}
