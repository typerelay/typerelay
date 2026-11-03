import Foundation

// Observe actual Foundation operations without replacing the production storage policy.
enum FileManager { static let `default` = ObservedFileManager() }
final class ObservedFileManager: Foundation.FileManager, @unchecked Sendable {
    var protectionWrites = [String]()
    var traversals = [String]()
    override func setAttributes(_ attributes: [FileAttributeKey: Any], ofItemAtPath path: String) throws {
        if attributes[.protectionKey] != nil { protectionWrites.append(path) }
        try super.setAttributes(attributes, ofItemAtPath: path)
    }
    override func contentsOfDirectory(at url: URL, includingPropertiesForKeys keys: [URLResourceKey]?, options: DirectoryEnumerationOptions = []) throws -> [URL] {
        traversals.append(url.path)
        return try super.contentsOfDirectory(at: url, includingPropertiesForKeys: keys, options: options)
    }
}

// Link the production bridge to a small Rust stand-in; all storage policy runs unchanged.
@_cdecl("typerelay_mobile_call")
func nativeCall(_ directory: UnsafePointer<CChar>, _ shared: UnsafePointer<CChar>, _ request: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>? {
    nativeCalls += 1
    let request = try! JSONSerialization.jsonObject(with: Data(String(cString: request).utf8)) as! [String: Any]
    let shared = URL(fileURLWithPath: String(cString: shared))
    do {
        if request["action"] as? String == "state" {
            let snapshot = shared.appendingPathComponent("keyboard.json")
            if request["invalid_snapshot"] as? Bool == true {
                try FileManager.default.removeItem(at: snapshot)
                try FileManager.default.createSymbolicLink(at: snapshot, withDestinationURL: shared.appendingPathComponent("system-owned"))
            } else { try Data("snapshot".utf8).write(to: snapshot, options: .atomic) }
        }
        if request["action"] as? String == "reset" {
            // Match Rust's revoke-first ordering, including a cleanup error for a non-directory cache.
            try Data(#"{"generation":"signed-out","libraries":[]}"#.utf8).write(to: shared.appendingPathComponent("keyboard.json"), options: .atomic)
            for name in ["usage", "assets"] {
                let url = shared.appendingPathComponent(name)
                if FileManager.default.fileExists(atPath: url.path) {
                    guard try url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else { throw NSError(domain: "Cleanup", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid cache directory"]) }
                    try FileManager.default.removeItem(at: url)
                }
            }
            let directory = URL(fileURLWithPath: String(cString: directory))
            if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
        }
    } catch {
        let data = try! JSONSerialization.data(withJSONObject: ["error": error.localizedDescription])
        return strdup(String(data: data, encoding: .utf8)!)
    }
    return strdup("{\"data\":{}}")
}
@_cdecl("typerelay_mobile_free")
func nativeFree(_ value: UnsafeMutablePointer<CChar>?) { free(value) }
var nativeCalls = 0
func check(_ condition: Bool, line: Int = #line) { assert(condition, "Check failed at line \(line)") }

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
        let assets = shared.appendingPathComponent("assets")
        try manager.createDirectory(at: assets, withIntermediateDirectories: true)
        let cached = assets.appendingPathComponent("cached")
        try Data("cached asset".utf8).write(to: cached)
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
        // Counts and an invalid child detect metadata rewrites and recursive visits without timing.
        assert(manager.protectionWrites.contains { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path == cached.resolvingSymlinksInPath().path })
        let invalidChild = assets.appendingPathComponent("invalid-child")
        try manager.createSymbolicLink(at: invalidChild, withDestinationURL: unrelated)
        let beforeRepeated = nativeCalls
        let writes = manager.protectionWrites.count; let traversals = manager.traversals.count
        for _ in 0..<20 {
            for action in ["asset", "render", "draft"] { _ = try TypeRelayCore.execute(["action": action], directory: directory, shared: shared) }
        }
        assert(nativeCalls == beforeRepeated + 60)
        assert(manager.protectionWrites.count == writes && manager.traversals.count == traversals)
        check(try assets.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        try manager.removeItem(at: invalidChild)

        // Failed initial repair stays retryable and must not reach Rust.
        let retryDirectory = root.appendingPathComponent("retry-private")
        let retryShared = root.appendingPathComponent("retry-shared")
        try manager.createDirectory(at: retryShared, withIntermediateDirectories: true)
        let retryAssets = retryShared.appendingPathComponent("assets")
        try Data().write(to: retryAssets)
        let beforeFailure = nativeCalls
        do {
            _ = try TypeRelayCore.execute(["action": "state"], directory: retryDirectory, shared: retryShared)
            fatalError("Storage error was swallowed")
        } catch { assert(nativeCalls == beforeFailure) }
        try manager.removeItem(at: retryAssets)
        try manager.createSymbolicLink(at: retryAssets, withDestinationURL: directory)
        do {
            _ = try TypeRelayCore.execute(["action": "state"], directory: retryDirectory, shared: retryShared)
            fatalError("Storage symbolic link was followed")
        } catch { assert(nativeCalls == beforeFailure) }
        try manager.removeItem(at: retryAssets)
        _ = try TypeRelayCore.execute(["action": "state"], directory: retryDirectory, shared: retryShared)
        assert(nativeCalls == beforeFailure + 1)

        // A failed replacement-protection step also retries preparation on the next call.
        do {
            _ = try TypeRelayCore.execute(["action": "state", "invalid_snapshot": true], directory: directory, shared: shared)
            fatalError("Snapshot protection failure was swallowed")
        } catch { assert(error.localizedDescription.contains("symbolic link")) }
        try manager.removeItem(at: snapshot)
        try manager.removeItem(at: assets)
        _ = try TypeRelayCore.execute(["action": "asset"], directory: directory, shared: shared)
        check(try URL(fileURLWithPath: assets.path).resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)

        // Reset bypasses invalid metadata on both a cold cache and a previously prepared cache.
        for (privateURL, sharedURL) in [(root.appendingPathComponent("cold-private"), root.appendingPathComponent("cold-shared")), (directory, shared)] {
            try manager.createDirectory(at: sharedURL, withIntermediateDirectories: true)
            let invalidAssets = sharedURL.appendingPathComponent("assets")
            if manager.fileExists(atPath: invalidAssets.path) { try manager.removeItem(at: invalidAssets) }
            try Data("invalid asset directory".utf8).write(to: invalidAssets)
            try Data(#"{"generation":"old","libraries":[{"private":"snippet"}]}"#.utf8).write(to: sharedURL.appendingPathComponent("keyboard.json"), options: .atomic)
            let beforeReset = nativeCalls
            do {
                _ = try TypeRelayCore.execute(["action": "reset"], directory: privateURL, shared: sharedURL)
                fatalError("Cleanup failure was swallowed")
            } catch { assert(error.localizedDescription == "Invalid cache directory") }
            assert(nativeCalls == beforeReset + 1)
            let revoked = sharedURL.appendingPathComponent("keyboard.json")
            let data = try JSONSerialization.jsonObject(with: Data(contentsOf: revoked)) as! [String: Any]
            assert((data["libraries"] as! [Any]).isEmpty && data["generation"] as? String == "signed-out")
            check(try revoked.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
            // A failed reset invalidates the repair cache too.
            try manager.removeItem(at: invalidAssets)
            _ = try TypeRelayCore.execute(["action": "state"], directory: privateURL, shared: sharedURL)
            check(try invalidAssets.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
            _ = try TypeRelayCore.execute(["action": "reset"], directory: privateURL, shared: sharedURL)
            assert(!manager.fileExists(atPath: privateURL.path))
            _ = try TypeRelayCore.execute(["action": "state"], directory: privateURL, shared: sharedURL)
            check(try privateURL.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        }
        print("iOS storage policy checks passed (macOS filesystem; device protection still needs iOS verification)")
    }
}
