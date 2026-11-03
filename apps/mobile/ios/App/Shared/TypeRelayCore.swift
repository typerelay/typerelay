import Foundation

final class TypeRelayCore {
    static let group = "group.com.typerelay.mobile"
    static let queue = DispatchQueue(label: "com.typerelay.mobile.storage")
    private static var preparedDirectories = Set<String>()
    static func sharedDirectory() throws -> URL {
        guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw NSError(domain: "TypeRelay", code: 0, userInfo: [NSLocalizedDescriptionKey: "Enable the TypeRelay App Group for both targets in Signing & Capabilities."]) }
        return url
    }
    static func directory() throws -> URL { try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("TypeRelay") }
    // Repair existing children once per app process; new children inherit their owned directory’s protection.
    static func protectStorage(directory: URL, shared: URL) throws {
        for url in [directory, shared.appendingPathComponent("keyboard.json"), shared.appendingPathComponent("assets"), shared.appendingPathComponent("usage")] {
            if FileManager.default.fileExists(atPath: url.path) { try protectResource(url, recursive: true) }
        }
    }
    private static func protectResource(_ path: URL, recursive: Bool = false) throws {
        var url = path
        let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values.isSymbolicLink != true else { throw NSError(domain: "TypeRelay", code: 0, userInfo: [NSLocalizedDescriptionKey: "Unexpected symbolic link in mobile storage."]) }
        var resource = URLResourceValues(); resource.isExcludedFromBackup = true; try url.setResourceValues(resource)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        if recursive && values.isDirectory == true { for child in try FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil) { try protectResource(child, recursive: true) } }
    }
    static func execute(_ request: [String: Any], keyboard: Bool = false) throws -> [String: Any] {
        let shared = try sharedDirectory()
        return try execute(request, directory: keyboard ? shared : directory(), shared: shared, keyboard: keyboard)
    }
    static func execute(_ request: [String: Any], directory: URL, shared: URL, keyboard: Bool = false) throws -> [String: Any] {
        let action = request["action"] as? String ?? ""
        if keyboard {
            guard ["keyboard", "keyboard_matches", "keyboard_render"].contains(action) else { throw NSError(domain: "TypeRelay", code: 0, userInfo: [NSLocalizedDescriptionKey: "The iOS keyboard has read-only storage access."]) }
        } else if action == "reset" {
            // Rust revokes keyboard visibility before cleanup; unrelated damaged caches must not block it.
            preparedDirectories.remove(directory.path)
        } else if !preparedDirectories.contains(directory.path) {
            for url in [directory, shared.appendingPathComponent("assets"), shared.appendingPathComponent("usage")] { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
            try protectStorage(directory: directory, shared: shared)
            preparedDirectories.insert(directory.path)
        }
        let json = String(data: try JSONSerialization.data(withJSONObject: request), encoding: .utf8)!
        guard let pointer = typerelay_mobile_call(directory.path, shared.path, json) else { throw NSError(domain: "TypeRelay", code: 0) }
        defer { typerelay_mobile_free(pointer) }
        // These Rust operations publish atomic replacements, including reset and partially failed syncs.
        if !keyboard && ["state", "save", "delete", "trash_action", "sync", "suspend", "reset"].contains(action) {
            let snapshot = shared.appendingPathComponent("keyboard.json")
            if FileManager.default.fileExists(atPath: snapshot.path) {
                do { try protectResource(snapshot) } catch { preparedDirectories.remove(directory.path); throw error }
            }
        }
        let response = try JSONSerialization.jsonObject(with: Data(String(cString: pointer).utf8)) as! [String: Any]
        if let error = response["error"] as? String { throw NSError(domain: "TypeRelay", code: response["status"] as? Int ?? 0, userInfo: [NSLocalizedDescriptionKey: error]) }
        return response
    }
}
