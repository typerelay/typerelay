import Foundation

// Link the production bridge to a small Rust stand-in; all storage policy runs unchanged.
@_cdecl("typerelay_mobile_call")
func nativeCall(_ directory: UnsafePointer<CChar>, _ shared: UnsafePointer<CChar>, _ request: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    nativeCalls += 1
    let action = try! JSONSerialization.jsonObject(with: Data(String(cString: request).utf8)) as! [String: Any]
    if action["action"] as? String == "state" {
        try! Data("snapshot".utf8).write(to: URL(fileURLWithPath: String(cString: shared)).appendingPathComponent("keyboard.json"), options: .atomic)
    }
    return strdup("{\"data\":{}}")
}
@_cdecl("typerelay_mobile_free")
func nativeFree(_ value: UnsafeMutablePointer<CChar>?) { free(value) }
var nativeCalls = 0
func check(_ condition: Bool) { assert(condition) }

@main struct StorageChecks {
    static func main() throws {
        let manager = FileManager.default
        let root = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? manager.removeItem(at: root) }
        let shared = root.appendingPathComponent("AppGroup/UUID")
        let directory = root.appendingPathComponent("Application Support/TypeRelay")
        try manager.createDirectory(at: shared, withIntermediateDirectories: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: true)
        let draft = directory.appendingPathComponent("typerelay.sqlite")
        try Data("existing drafts".utf8).write(to: draft)
        let unrelated = shared.appendingPathComponent("system-owned")
        try Data("untouched".utf8).write(to: unrelated)
        let originalRoot = try shared.resourceValues(forKeys: [.isExcludedFromBackupKey])
        _ = try TypeRelayCore.execute(["action": "state"], directory: directory, shared: shared)
        check(try Data(contentsOf: draft) == Data("existing drafts".utf8))
        check(try URL(fileURLWithPath: shared.path).resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == originalRoot.isExcludedFromBackup)
        check(try unrelated.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup != true)
        for url in [directory, draft, shared.appendingPathComponent("keyboard.json"), shared.appendingPathComponent("assets"), shared.appendingPathComponent("usage")] {
            check(try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        }
        // Atomic replacement must also receive metadata on the next call.
        _ = try TypeRelayCore.execute(["action": "state"], directory: directory, shared: shared)
        check(try shared.appendingPathComponent("keyboard.json").resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        let beforeCopy = nativeCalls
        _ = try TypeRelayCore.execute(["action": "keyboard_usage"], directory: directory, shared: shared)
        assert(nativeCalls == beforeCopy + 1)
        var snapshot = shared.appendingPathComponent("keyboard.json")
        var readable = URLResourceValues(); readable.isExcludedFromBackup = false; try snapshot.setResourceValues(readable)
        let beforeReads = nativeCalls
        for action in ["keyboard", "keyboard_matches", "keyboard_render"] {
            _ = try TypeRelayCore.execute(["action": action], directory: shared, shared: shared, keyboard: true)
        }
        assert(nativeCalls == beforeReads + 3)
        check(try URL(fileURLWithPath: snapshot.path).resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == false)
        do {
            _ = try TypeRelayCore.execute(["action": "keyboard_usage"], directory: shared, shared: shared, keyboard: true)
            fatalError("Keyboard write reached native core")
        } catch { assert(nativeCalls == beforeReads + 3) }
        // A storage failure must surface instead of reaching Rust.
        try manager.removeItem(at: shared.appendingPathComponent("assets"))
        try Data().write(to: shared.appendingPathComponent("assets"))
        do {
            _ = try TypeRelayCore.execute(["action": "state"], directory: directory, shared: shared)
            fatalError("Storage error was swallowed")
        } catch { assert(nativeCalls == beforeReads + 3) }
        try manager.removeItem(at: shared.appendingPathComponent("assets"))
        try manager.createSymbolicLink(at: shared.appendingPathComponent("assets"), withDestinationURL: directory)
        do {
            _ = try TypeRelayCore.execute(["action": "state"], directory: directory, shared: shared)
            fatalError("Storage symbolic link was followed")
        } catch { assert(nativeCalls == beforeReads + 3) }
        print("iOS storage policy checks passed (macOS filesystem; device protection still needs iOS verification)")
    }
}
