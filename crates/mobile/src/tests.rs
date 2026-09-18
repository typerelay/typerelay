use super::*;
use typerelay_client::config::Match;

struct Fixture { private: tempfile::TempDir, shared: tempfile::TempDir, library: String }
impl Fixture {
    fn new() -> Self {
        let private = tempfile::tempdir().unwrap(); let shared = tempfile::tempdir().unwrap();
        let db = Database::open(private.path()).unwrap();
        let remote = json!({"_id":"0123456789abcdef01234567","name":"Team","revision":1,"state":"active","permissions":{"read":true,"edit":true,"manage":true},"records":[{"id":"snippet-one","trigger":"hello","title":"Greeting","revision":1,"position":0,"state":"active","content":{"version":1,"type":"plain_text","text":"Hello"}}]});
        db.apply(&json!({"libraries":[remote],"accessible":["0123456789abcdef01234567"],"protocol":6,"cursor":1}), None).unwrap();
        Self { private, shared, library: "0123456789abcdef01234567".into() }
    }
    fn call(&self, request: Value) -> Result<Value> { Mobile::dispatch(self.private.path(), self.shared.path(), &request) }
    fn edit(&self, revision: i64, text: &str) -> Result<Value> { self.call(json!({"action":"save","operation_id":format!("save-operation-{revision}"),"library":self.library,"id":"snippet-one","record_revision":revision,"entry":Match{trigger:"hello".into(),replace:text.into(),..Default::default()}})) }
}

#[test]
fn offline_edits_survive_restart_and_use_the_existing_outbox() {
    let fixture = Fixture::new(); fixture.edit(1, "Offline change").unwrap();
    let db = Database::open(fixture.private.path()).unwrap();
    assert_eq!(db.pending().unwrap().len(), 1);
    let operation = db.pending().unwrap()[0].1.clone();
    assert_eq!(operation["body"]["changes"][0]["base_revision"], 1);
    assert_eq!(operation["body"]["changes"][0]["value"]["content"]["text"], "Offline change");
    assert_eq!(fixture.call(json!({"action":"state"})).unwrap()["libraries"][0]["records"][0]["content"]["text"], "Offline change");
    assert!(fixture.edit(1, "Stale overwrite").is_err());
    assert_eq!(db.pending().unwrap()[0].1["body"]["operation_id"], operation["body"]["operation_id"]);
}

#[test]
fn keyboard_generation_is_stable_across_connections_and_rejects_stale_selection() {
    let fixture = Fixture::new();
    let first = fixture.call(json!({"action":"state"})).unwrap();
    assert_eq!(first["mobile_bridge_version"], 2);
    assert_eq!(first["generation"], fixture.call(json!({"action":"state"})).unwrap()["generation"]);
    let request = json!({"action":"keyboard_render","generation":first["generation"],"library":fixture.library,"id":"snippet-one"});
    assert_eq!(fixture.call(request.clone()).unwrap()["text"], "Hello");
    fixture.edit(1, "New content").unwrap();
    assert!(fixture.call(request).is_err());
    assert_ne!(first["generation"], fixture.call(json!({"action":"state"})).unwrap()["generation"]);
}

#[test]
fn snapshot_excludes_drafts_and_revoked_libraries_and_reset_scrubs_data() {
    let fixture = Fixture::new();
    fixture.call(json!({"action":"draft","draft":{"secret":"Unsent draft"}})).unwrap();
    fixture.call(json!({"action":"state"})).unwrap();
    assert!(!fs::read_to_string(fixture.shared.path().join("keyboard.json")).unwrap().contains("Unsent draft"));
    Database::open(fixture.private.path()).unwrap().apply(&json!({"accessible":[],"libraries":[],"cursor":2}), None).unwrap();
    fixture.call(json!({"action":"state"})).unwrap();
    assert_eq!(fixture.call(json!({"action":"keyboard"})).unwrap()["libraries"], json!([]));
    fixture.call(json!({"action":"reset"})).unwrap();
    assert!(!fixture.private.path().join("typerelay.sqlite").exists());
}

#[test]
fn suspended_keyboard_stays_empty_when_app_reads_state() {
    let fixture = Fixture::new(); fixture.call(json!({"action":"suspend"})).unwrap();
    assert_eq!(fixture.call(json!({"action":"state"})).unwrap()["libraries"].as_array().unwrap().len(), 1);
    assert!(fixture.call(json!({"action":"keyboard"})).unwrap()["libraries"].as_array().unwrap().is_empty());
}

#[test]
fn keyboard_renderer_shares_template_validation_and_retains_action_limits() {
    let content = json!({"version":1,"type":"template","text":"Hi {{name}}{{key:enter}}","variables":{"name":{"required":true}}});
    assert!(Mobile::render(&content, &json!({}), BTreeMap::new()).is_err());
    let rendered = Mobile::render(&content, &json!({"values":{"name":"Nitai"}}), BTreeMap::new()).unwrap();
    assert_eq!(rendered["text"], "Hi Nitai"); assert_eq!(rendered["enter_actions"], 1);
    let code = json!({"version":1,"type":"code","text":"{{name}}"});
    assert_eq!(Mobile::render(&code, &json!({}), BTreeMap::new()).unwrap()["text"], "{{name}}");
}

#[test]
fn rich_assets_are_shared_without_credentials_and_removed_after_revocation() {
    let fixture = Fixture::new();
    let metadata = fixture.call(json!({"action":"asset_import","base64":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="})).unwrap();
    let id = metadata["id"].as_str().unwrap();
    fixture.call(json!({"action":"save","operation_id":"rich-save-operation","library":fixture.library,"id":"snippet-one","record_revision":1,"entry":Match{trigger:"hello".into(),replace:format!("**Hello**\n\n![dot](typerelay-asset:{id})"),kind:"rich_text".into(),..Default::default()}})).unwrap();
    let snapshot = fixture.call(json!({"action":"keyboard"})).unwrap();
    let output = fixture.call(json!({"action":"keyboard_render","generation":snapshot["generation"],"library":fixture.library,"id":"snippet-one"})).unwrap();
    assert!(!output["html"].as_str().unwrap().contains("data:image/"));
    assert_eq!(output["assets"][0], id);
    assert!(fixture.shared.path().join("assets").join(id).exists());
    let clipboard = fixture.call(json!({"action":"keyboard_render","generation":snapshot["generation"],"library":fixture.library,"id":"snippet-one","clipboard":true})).unwrap();
    assert!(clipboard["html"].as_str().unwrap().contains("data:image/"));
    assert!(!fixture.private.path().join("sync/credentials.json").exists());
    Database::open(fixture.private.path()).unwrap().apply(&json!({"accessible":[],"libraries":[]}), None).unwrap();
    fixture.call(json!({"action":"state"})).unwrap();
    assert!(!fixture.shared.path().join("assets").join(id).exists());
}

#[test]
fn lost_native_response_replays_the_same_local_save_once() {
    let fixture = Fixture::new();
    let request = json!({"action":"save","operation_id":"stable-native-operation","library":fixture.library,"entry":Match{trigger:"new".into(),replace:"New snippet".into(),..Default::default()}});
    let result = fixture.call(request.clone()).unwrap();
    assert_eq!(fixture.call(request.clone()).unwrap(), result);
    let db = Database::open(fixture.private.path()).unwrap();
    assert_eq!(db.pending().unwrap().len(), 1);
    assert_eq!(db.records(&fixture.library).unwrap().len(), 2);
    let mut different = request; different["entry"]["replace"] = json!("Different content");
    assert!(fixture.call(different).is_err());
}

#[test]
fn rejected_save_rolls_back_record_outbox_and_acknowledgement() {
    let fixture = Fixture::new();
    let request = json!({"action":"save","operation_id":"rejected-native-operation","library":fixture.library,"entry":Match{trigger:"hello".into(),replace:"Collision".into(),..Default::default()}});
    assert!(fixture.call(request).is_err());
    let db = Database::open(fixture.private.path()).unwrap();
    assert!(db.pending().unwrap().is_empty());
    assert!(db.meta("mobile-save-rejected-native-operation").unwrap().is_none());
    assert_eq!(db.records(&fixture.library).unwrap().len(), 1);
}

#[test]
fn mobile_delete_is_offline_durable_and_idempotent() {
    let fixture = Fixture::new();
    let request = json!({"action":"delete","operation_id":"delete-operation-one","library":fixture.library,"id":"snippet-one","record_revision":1});
    let result = fixture.call(request.clone()).unwrap();
    assert_eq!(result["deleted"], true);
    assert_eq!(fixture.call(request).unwrap(), result);
    let db = Database::open(fixture.private.path()).unwrap();
    assert_eq!(db.pending().unwrap().len(), 1);
    assert!(db.records(&fixture.library).unwrap().iter().all(|record| record["state"] != "active"));
    assert!(fixture.call(json!({"action":"keyboard"})).unwrap()["libraries"][0]["records"].as_array().unwrap().is_empty());
    let trash = fixture.call(json!({"action":"trash"})).unwrap();
    assert_eq!(trash[0]["name"], "Greeting"); assert_eq!(trash[0]["library_name"], "Team"); assert_eq!(trash[0]["can_restore"], true);
    let restore = json!({"action":"trash_action","trash_action":"restore","operation_id":"restore-operation-one","target":trash[0]});
    let restored = fixture.call(restore.clone()).unwrap(); assert_eq!(fixture.call(restore).unwrap(), restored);
    let db = Database::open(fixture.private.path()).unwrap(); assert_eq!(db.pending().unwrap().len(), 2);
    assert_eq!(fixture.call(json!({"action":"state"})).unwrap()["libraries"][0]["records"][0]["state"], "active");
}

#[test]
fn identities_cannot_mix_accounts_or_server_origins() {
    let fixture = Fixture::new();
    let request = json!({"action":"bind","server":"https://example.test","account":"account-one"});
    fixture.call(request.clone()).unwrap(); fixture.call(request).unwrap();
    assert!(fixture.call(json!({"action":"bind","server":"https://other.test","account":"account-one"})).is_err());
    assert!(fixture.call(json!({"action":"bind","server":"https://example.test","account":"account-two"})).is_err());
}

#[test]
fn conflict_resolution_is_durable_and_duplicate_taps_do_not_queue_twice() {
    let fixture = Fixture::new();
    let db = Database::open(fixture.private.path()).unwrap();
    db.set_meta("conflicts", &json!([{"_id":"conflict-one","library":fixture.library}])).unwrap();
    let request = json!({"action":"resolve","id":"conflict-one","choice":"local","operation_id":"resolve-operation-one"});
    fixture.call(request.clone()).unwrap(); fixture.call(request).unwrap();
    let operations = Database::open(fixture.private.path()).unwrap().pending().unwrap();
    assert_eq!(operations.len(), 1); assert_eq!(operations[0].1["kind"], "resolve");
    assert_eq!(operations[0].1["body"]["base_revision"], 1);
}

#[test]
fn mobile_sync_retries_a_lost_server_response_without_persisting_credentials() {
    use std::{io::{Read, Write}, net::TcpListener, time::{Duration, Instant}};
    let fixture = Fixture::new(); fixture.edit(1, "Offline change").unwrap();
    let db = Database::open(fixture.private.path()).unwrap();
    let mut remote = db.library(&fixture.library).unwrap();
    remote["records"] = json!(db.records(&fixture.library).unwrap());
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let worker = std::thread::spawn(move || {
        let mut submissions = Vec::new(); let mut requests = 0;
        let deadline = Instant::now() + Duration::from_secs(10);
        while requests < 5 {
            assert!(Instant::now() < deadline, "Mock sync server timed out");
            let (mut stream, _) = match listener.accept() { Ok(value) => value, Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => { std::thread::sleep(Duration::from_millis(5)); continue; }, Err(error) => panic!("{error}") };
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut bytes = Vec::new(); let mut byte = [0];
            while !bytes.ends_with(b"\r\n\r\n") { stream.read_exact(&mut byte).unwrap(); bytes.push(byte[0]); }
            let headers = String::from_utf8(bytes).unwrap().to_lowercase();
            assert!(headers.contains("authorization: bearer test-access"));
            assert!(headers.contains("x-typerelay-sync-protocol: 6"));
            let size = headers.lines().find_map(|line|line.strip_prefix("content-length: ")).map(|size|size.parse::<usize>().unwrap()).unwrap_or(0);
            let mut body = vec![0; size]; stream.read_exact(&mut body).unwrap(); requests += 1;
            let response = if headers.starts_with("post ") {
                let body: Value = serde_json::from_slice(&body).unwrap(); submissions.push(body["operation_id"].clone());
                if submissions.len() == 1 { continue; } // Accepted remotely, but its HTTP response was lost.
                json!({"library":remote,"conflicts":[]})
            } else { json!({"protocol":6,"cursor":2,"accessible":[remote["_id"]],"libraries":[remote],"assets":[],"conflicts":[]}) };
            let json = response.to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", json.len(), json).unwrap();
        }
        assert_eq!(submissions.len(), 2); assert_eq!(submissions[0], submissions[1]);
    });
    let request = json!({"action":"sync","server":server,"access_token":"test-access"});
    assert!(fixture.call(request.clone()).is_err());
    assert_eq!(Database::open(fixture.private.path()).unwrap().pending().unwrap().len(), 1);
    fixture.call(request).unwrap(); worker.join().unwrap();
    assert!(Database::open(fixture.private.path()).unwrap().pending().unwrap().is_empty());
    assert!(!fixture.private.path().join("sync/credentials.json").exists());
}
