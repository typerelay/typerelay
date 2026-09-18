import Foundation

final class TypeRelayCore {
    static let group = "group.com.typerelay.mobile"
    static let queue = DispatchQueue(label: "com.typerelay.mobile.storage")
    static func sharedDirectory() throws -> URL {
        guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { throw NSError(domain: "TypeRelay", code: 0, userInfo: [NSLocalizedDescriptionKey: "Enable the TypeRelay App Group for both targets in Signing & Capabilities."]) }
        return url
    }
    static func directory() throws -> URL { try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("TypeRelay") }
    static func execute(_ request: [String: Any], keyboard: Bool = false) throws -> [String: Any] {
        let shared = try sharedDirectory()
        let directory = keyboard ? shared : try directory()
        if !keyboard {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            for var url in [directory, shared] {
                var resource = URLResourceValues(); resource.isExcludedFromBackup = true; try url.setResourceValues(resource)
                try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
            }
        }
        let json = String(data: try JSONSerialization.data(withJSONObject: request), encoding: .utf8)!
        guard let pointer = typerelay_mobile_call(directory.path, shared.path, json) else { throw NSError(domain: "TypeRelay", code: 0) }
        defer { typerelay_mobile_free(pointer) }
        let response = try JSONSerialization.jsonObject(with: Data(String(cString: pointer).utf8)) as! [String: Any]
        if let error = response["error"] as? String { throw NSError(domain: "TypeRelay", code: response["status"] as? Int ?? 0, userInfo: [NSLocalizedDescriptionKey: error]) }
        return response
    }
}
