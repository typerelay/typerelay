import AuthenticationServices
import Capacitor
import UIKit
import UniformTypeIdentifiers

@objc(TypeRelayPlugin)
public class TypeRelayPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "TypeRelayPlugin"
    public let jsName = "TypeRelay"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "execute", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "copy", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "keyboardSettings", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "authenticate", returnType: CAPPluginReturnPromise), CAPPluginMethod(name: "cancelAuthentication", returnType: CAPPluginReturnPromise)]
    private var authentication: (session: ASWebAuthenticationSession, call: CAPPluginCall)?
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
    // Shares Safari sign-in state and returns the OAuth callback without an "Open in app" prompt.
    @objc func authenticate(_ call: CAPPluginCall) {
        guard let url = URL(string: call.getString("url") ?? ""), url.scheme == "https", let scheme = call.getString("scheme") else { call.reject("Invalid sign-in URL"); return }
        DispatchQueue.main.async {
            self.endAuthentication()
            var session: ASWebAuthenticationSession!
            session = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { [weak self] callback, error in
                guard let self, self.authentication?.session === session else { return }
                self.authentication = nil
                if let callback { call.resolve(["url": callback.absoluteString]) } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin { call.resolve() } else { call.reject(error?.localizedDescription ?? "Sign-in failed") }
            }
            session.presentationContextProvider = self
            self.authentication = (session, call)
            if !session.start() { self.authentication = nil; call.reject("Could not open sign-in") }
        }
    }
    @objc func cancelAuthentication(_ call: CAPPluginCall) { DispatchQueue.main.async { self.endAuthentication(); call.resolve() } }
    // Settles the pending JavaScript call because cancel() may not invoke the completion handler.
    private func endAuthentication() { guard let current = authentication else { return }; authentication = nil; current.session.cancel(); current.call.resolve() }
}

extension TypeRelayPlugin: ASWebAuthenticationPresentationContextProviding {
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor { bridge?.webView?.window ?? ASPresentationAnchor() }
}

class TypeRelayViewController: CAPBridgeViewController {
    override func capacitorDidLoad() { bridge?.registerPluginInstance(TypeRelayPlugin()) }
}
