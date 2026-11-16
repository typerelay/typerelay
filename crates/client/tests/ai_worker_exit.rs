//! Quitting the app must not cut off another client's AI request, and the worker must still exit afterwards.
use std::{net::TcpStream, process::Command, time::{Duration, Instant}};
use typerelay_client::native_ai::NativeAi;

#[test]
fn idle_shutdown_waits_for_other_clients_then_exits() {
    let root = tempfile::tempdir().unwrap();
    let mut worker = Command::new(env!("CARGO_BIN_EXE_typerelay-ai")).arg("--root").arg(root.path()).arg("--cpu").spawn().unwrap();
    let endpoint = root.path().join("native-ai/endpoint.json");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !endpoint.is_file() { assert!(Instant::now() < deadline, "worker did not start"); std::thread::sleep(Duration::from_millis(20)); }
    let endpoint: serde_json::Value = serde_json::from_slice(&std::fs::read(endpoint).unwrap()).unwrap();
    let address = endpoint["address"].as_str().unwrap();
    let busy = TcpStream::connect(address).unwrap(); // Another client mid-request: connected, request not finished.
    std::thread::sleep(Duration::from_millis(200));
    NativeAi::release(root.path()).unwrap();
    std::thread::sleep(Duration::from_millis(500));
    assert!(worker.try_wait().unwrap().is_none(), "worker exited while another client was busy");
    drop(busy);
    let deadline = Instant::now() + Duration::from_secs(5);
    while worker.try_wait().unwrap().is_none() { assert!(Instant::now() < deadline, "worker did not exit after the last client finished"); std::thread::sleep(Duration::from_millis(20)); }
}
