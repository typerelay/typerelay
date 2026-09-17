import Capacitor
import UIKit
import UniformTypeIdentifiers

@objc(TypeRelayPlugin)
public class TypeRelayPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TypeRelayPlugin"
    public let jsName = "TypeRelay"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "execute", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "copy", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "keyboardSettings", returnType: CAPPluginReturnPromise)]
    @objc func execute(_ call: CAPPluginCall) {
        guard let json = call.getString("request"), let bytes = json.data(using: .utf8) else { call.reject("Missing request"); return }
        TypeRelayCore.queue.async {
            do {
                guard let request = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw NSError(domain: "TypeRelay", code: 0) }
                let response = try TypeRelayCore.execute(request)
                DispatchQueue.main.async { call.resolve(response) }
            } catch { DispatchQueue.main.async { call.reject(error.localizedDescription, String((error as NSError).code), error) } }
        }
    }
    @objc func copy(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var item: [String: Any] = [UTType.utf8PlainText.identifier: call.getString("text") ?? ""]
            if let html = call.getString("html") { item[UTType.html.identifier] = Data(html.utf8) }
            if let rtf = call.getString("rtf") { item[UTType.rtf.identifier] = Data(rtf.utf8) }
            UIPasteboard.general.setItems([item], options: [.localOnly: true])
            call.resolve()
        }
    }
    @objc func keyboardSettings(_ call: CAPPluginCall) { DispatchQueue.main.async { UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!) { _ in call.resolve() } } }
}

class TypeRelayViewController: CAPBridgeViewController {
    override func capacitorDidLoad() { bridge?.registerPluginInstance(TypeRelayPlugin()) }
}
