use std::{fs, io::{Read, Write}, net::TcpListener};
use serde_json::json;
use sha2::{Digest, Sha256};
use typerelay_client::{database::Database, sync::{Credentials, Sync}};

fn image(db: &Database, color: u32) -> String {
    let image = image::RgbaImage::from_pixel(1, 1, image::Rgba([color as u8, (color >> 8) as u8, 0, 128]));
    let mut output = std::io::Cursor::new(Vec::new()); image.write_to(&mut output, image::ImageFormat::Png).unwrap();
    let bytes = output.into_inner(); let id = format!("{:x}", Sha256::digest(&bytes));
    db.put_asset(&json!({"id":id,"mime_type":"image/png","size":bytes.len(),"width":1,"height":1,"animated":false,"source_urls":["https://example.test/one.png","https://example.test/two.png"]}), &bytes, true).unwrap();
    id
}

#[test]
fn bundles_roundtrip_500_images_and_preserve_existing_destinations() {
    let root = tempfile::tempdir().unwrap(); let db = Database::open(&root.path().join("source")).unwrap();
    let entries: Vec<_> = (0..500).map(|i| json!({"trigger":format!("i{i}"),"type":"rich_text","replace":format!("![](typerelay-asset:{})",image(&db,i))})).collect();
    db.import("Images", &json!({"matches":entries}).to_string()).unwrap();
    let path = root.path().join("images.typerelay.zip"); db.export("Images", &path).unwrap();
    let original = fs::read(&path).unwrap(); assert!(db.export("Images", &path).is_err()); assert_eq!(fs::read(&path).unwrap(), original);
    let archive = zip::ZipArchive::new(fs::File::open(&path).unwrap()).unwrap(); assert_eq!(archive.len(), 502);
    let target = Database::open(&root.path().join("target")).unwrap(); assert_eq!(target.import_bundle("Restored", &path).unwrap().entries.len(), 500);
    let id = entries[0]["replace"].as_str().unwrap().trim_start_matches("![](typerelay-asset:").trim_end_matches(')');
    assert_eq!(target.asset(id).unwrap().unwrap().0["source_urls"], json!(["https://example.test/one.png","https://example.test/two.png"]));
    let more: Vec<_> = (0..999).map(|i| json!({"trigger":format!("many{i}"),"type":"rich_text","replace":format!("![](typerelay-asset:{})",image(&db,i))})).collect();
    db.import("Too many", &json!({"matches":more}).to_string()).unwrap();
    let refused = root.path().join("refused.typerelay.zip"); assert!(db.export("Too many", &refused).is_err()); assert!(!refused.exists());
}

#[test]
fn legacy_native_bundle_sources_are_still_read() {
    let root = tempfile::tempdir().unwrap(); let db = Database::open(&root.path().join("source")).unwrap(); let id = image(&db, 1);
    let (metadata, bytes) = db.asset(&id).unwrap().unwrap(); let path = root.path().join("legacy.typerelay.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap()); let options = zip::write::SimpleFileOptions::default();
    for (name, bytes) in [("bundle.json".into(), json!({"version":1,"name":"Old","assets":[id]}).to_string().into_bytes()), ("snippets.yml".into(), json!({"matches":[{"trigger":"old","type":"rich_text","replace":format!("![](typerelay-asset:{id})")}]}).to_string().into_bytes()), (format!("metadata/{id}.json"), metadata.to_string().into_bytes()), (format!("assets/{id}"), bytes)] { zip.start_file(name, options).unwrap(); zip.write_all(&bytes).unwrap(); }
    zip.finish().unwrap();
    let target = Database::open(&root.path().join("target")).unwrap(); target.import_bundle("Old", &path).unwrap();
    assert_eq!(target.asset(&id).unwrap().unwrap().0["source_urls"], metadata["source_urls"]);
}

#[test]
fn sync_only_transfers_pending_references_and_checks_each_account() {
    let root = tempfile::tempdir().unwrap(); let directory = root.path().join("data"); let db = Database::open(&directory).unwrap(); let id = image(&db, 1); let private_id = image(&db, 2);
    db.import("Private", &json!({"matches":[{"trigger":"private","type":"rich_text","replace":format!("![](typerelay-asset:{private_id})")}]}).to_string()).unwrap();
    db.import("Selected", &json!({"matches":[{"trigger":"selected","type":"rich_text","replace":format!("![](typerelay-asset:{id})")}]}).to_string()).unwrap();
    assert!(db.pending_asset_ids().unwrap().is_empty()); db.enroll("Selected").unwrap(); assert_eq!(db.pending_asset_ids().unwrap(), vec![id.clone()]);
    // An earlier account's uploaded flag must never suppress the current account's presence check.
    for account in ["first", "second"] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let server = format!("http://{}", listener.local_addr().unwrap()); let expected = id.clone();
        let worker = std::thread::spawn(move || {
            let mut paths = Vec::new();
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().unwrap(); let mut headers = Vec::new(); let mut byte = [0];
                while !headers.ends_with(b"\r\n\r\n") { stream.read_exact(&mut byte).unwrap(); headers.push(byte[0]); }
                let headers = String::from_utf8(headers).unwrap(); let path = headers.lines().next().unwrap().to_owned();
                let length = headers.lines().find_map(|line| line.to_lowercase().strip_prefix("content-length: ").and_then(|value| value.parse::<usize>().ok())).unwrap_or(0);
                let mut bytes = vec![0; length]; stream.read_exact(&mut bytes).unwrap();
                let (status, body) = if path.starts_with("GET ") { ("200 OK", json!({"protocol":6,"cursor":0,"libraries":[],"assets":[],"conflicts":[]})) }
                else if path.starts_with("POST /api/v2/assets/presence ") { assert_eq!(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap()["ids"], json!([expected])); ("200 OK", json!({"missing":[expected],"assets":[]})) }
                else if path.starts_with("PUT ") { assert!(path.contains(&expected)); assert_eq!(format!("{:x}",Sha256::digest(&bytes)), expected); ("200 OK",json!({})) }
                else { assert!(path.starts_with("POST /api/v2/libraries ")); ("503 Service Unavailable",json!({"error":"retry"})) };
                paths.push(path); let body = body.to_string(); write!(stream,"HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
            paths
        });
        let sync = Sync::new(root.path().join("sync-root"), directory.clone()).unwrap();
        assert!(sync.cycle_authenticated(&mut Credentials { server, access_token:"test".into(), refresh_token:String::new(), account:Some(account.into()), device:None }).is_err());
        let paths = worker.join().unwrap(); assert!(paths[1].contains("assets/presence")); assert!(paths[2].starts_with("PUT ")); assert!(!paths.iter().any(|path| path.contains(&private_id)));
    }
}

#[test]
fn oversized_bundles_are_rejected_before_import() {
    let root = tempfile::tempdir().unwrap(); let db = Database::open(&root.path().join("data")).unwrap(); let path = root.path().join("large.typerelay.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap()); let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("bundle.json", options).unwrap(); zip.write_all(br#"{"version":1,"assets":[]}"#).unwrap();
    zip.start_file("snippets.yml", options).unwrap(); zip.write_all(&vec![b' '; 25 * 1048576]).unwrap(); zip.finish().unwrap();
    assert!(db.import_bundle("Large", &path).unwrap_err().to_string().contains("Expanded bundle exceeds"));
    fs::File::create(&path).unwrap().set_len(16 * 1048576 + 1).unwrap();
    assert!(db.import_bundle("Large", &path).unwrap_err().to_string().contains("Bundle exceeds 16 MiB"));
    assert!(db.libraries().unwrap().is_empty());
}
