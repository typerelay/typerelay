//! Retain the three newest completed Linux installer snapshots.
use std::{
    env, fs, io,
    path::{Path, PathBuf},
};

pub fn prune() -> io::Result<()> {
    let data = env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share")))
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Missing Linux data directory"))?;
    prune_at(&data.join("typerelay"))
}

fn prune_at(data: &Path) -> io::Result<()> {
    match fs::symlink_metadata(data) {
        Ok(info) if !info.is_dir() => return Ok(()),
        Ok(_) => (),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let lock = fs::File::open(data)?;
    lock.lock()?;
    let mut backups = Vec::new();
    for entry in fs::read_dir(data)? {
        let entry = entry?;
        let name = entry.file_name();
        // tempfile.mkdtemp uses eight lowercase letters, digits or underscores.
        if !name
            .to_str()
            .and_then(|name| name.strip_prefix("storage-upgrade-"))
            .is_some_and(|id| {
                id.len() == 8
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            })
            || !entry.file_type()?.is_dir()
        {
            continue;
        }
        let mut contents = fs::read_dir(entry.path())?;
        let Some(config) = contents.next().transpose()? else {
            continue;
        };
        if config.file_name() != "config"
            || !config.file_type()?.is_dir()
            || contents.next().transpose()?.is_some()
        {
            continue;
        }
        backups.push((entry.metadata()?.modified()?, entry.path()));
    }
    backups.sort_unstable();
    for (_, directory) in backups.iter().rev().skip(3) {
        fs::remove_dir_all(directory)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::symlink,
        time::{Duration, SystemTime},
    };

    #[test]
    fn keeps_three_newest_completed_backups() {
        let home = tempfile::tempdir().unwrap();
        let data = home.path();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(outside.path().join("config")).unwrap();
        symlink(outside.path(), data.join("storage-upgrade-aaaaaaaa")).unwrap();
        let incomplete = data.join(".storage-upgrade-00000009");
        fs::create_dir_all(incomplete.join("config")).unwrap();
        let unrelated = data.join("storage-upgrade-personal");
        fs::create_dir_all(unrelated.join("config")).unwrap();
        fs::write(unrelated.join("notes"), "keep").unwrap();
        let linked_config = data.join("storage-upgrade-00000008");
        fs::create_dir(&linked_config).unwrap();
        symlink(outside.path(), linked_config.join("config")).unwrap();
        for i in 0..6 {
            let path = data.join(format!("storage-upgrade-{i:08}"));
            fs::create_dir_all(path.join("config")).unwrap();
            fs::File::open(path)
                .unwrap()
                .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(i))
                .unwrap();
        }
        prune_at(data).unwrap();
        prune_at(data).unwrap();
        for i in 0..6 {
            assert_eq!(
                data.join(format!("storage-upgrade-{i:08}")).exists(),
                i >= 3
            );
        }
        assert!(
            outside.path().join("config").exists()
                && linked_config.exists()
                && incomplete.exists()
                && unrelated.exists()
        );
    }
}
