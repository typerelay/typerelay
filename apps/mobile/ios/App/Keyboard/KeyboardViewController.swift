import UIKit

final class KeyboardViewController: UIInputViewController {
    private var stack = UIStackView()
    private var results = UIStackView()
    private var queryButton = UIButton(type: .system)
    private var status = UILabel()
    private var snapshot: [String: Any] = [:]
    private var library = ""
    private var query = ""
    private var selection: [String: Any]?
    private var selectionLibrary = ""
    private var values: [String: String] = [:]
    private var field: String?
    private var shifted = false
    private var numbers = false
    private var letterRows: [UIStackView] = []
    private var fields: [(String, [String: Any])] = []
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        stack.axis = .vertical; stack.spacing = 4; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8), stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8), stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 4), stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -4), view.heightAnchor.constraint(equalToConstant: 360)])
        let toolbar = UIStackView(); toolbar.distribution = .fillEqually
        let globe = button("🌐") { [weak self] in self?.advanceToNextInputMode() }; globe.accessibilityLabel = "Next keyboard"
        globe.addTarget(self, action: #selector(handleInputModeList(from:with:)), for: .allTouchEvents)
        toolbar.addArrangedSubview(globe)
        let libraries = button("Libraries") { [weak self] in self?.chooseLibrary() }; toolbar.addArrangedSubview(libraries)
        toolbar.addArrangedSubview(button("Back") { [weak self] in self?.selection = nil; self?.field = nil; self?.refresh() })
        stack.addArrangedSubview(toolbar)
        queryButton = button("Search snippets") { [weak self] in self?.field = nil; self?.updateQuery() }; queryButton.contentHorizontalAlignment = .leading; stack.addArrangedSubview(queryButton)
        let scroll = UIScrollView(); results.axis = .vertical; results.spacing = 4; results.translatesAutoresizingMaskIntoConstraints = false; scroll.addSubview(results)
        NSLayoutConstraint.activate([results.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor), results.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor), results.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor), results.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor), results.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor)])
        stack.addArrangedSubview(scroll)
        status.font = .preferredFont(forTextStyle: .caption1); status.numberOfLines = 2; stack.addArrangedSubview(status)
        for _ in 0..<3 { let row = UIStackView(); row.distribution = .fillEqually; row.spacing = 2; row.heightAnchor.constraint(equalToConstant: 32).isActive = true; letterRows.append(row); stack.addArrangedSubview(row) }
        let controls = UIStackView(); controls.distribution = .fillEqually; controls.heightAnchor.constraint(equalToConstant: 32).isActive = true
        controls.addArrangedSubview(button("⇧") { [weak self] in guard let self else { return }; self.shifted.toggle(); self.keys() })
        controls.addArrangedSubview(button("123") { [weak self] in guard let self else { return }; self.numbers.toggle(); self.keys() })
        controls.addArrangedSubview(button("Space") { [weak self] in self?.type(" ") })
        controls.addArrangedSubview(button("⌫") { [weak self] in self?.erase() })
        controls.addArrangedSubview(button("↵") { [weak self] in self?.type("\n") })
        stack.addArrangedSubview(controls); keys()
    }
    override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated); refresh() }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); values.removeAll(); selection = nil; field = nil; query = "" }
    private func button(_ title: String, action: @escaping () -> Void) -> UIButton { let button = UIButton(type: .system); button.setTitle(title, for: .normal); button.addAction(UIAction { _ in action() }, for: .touchUpInside); return button }
    private func clearResults() { results.arrangedSubviews.forEach { $0.removeFromSuperview() } }
    private func keys() {
        let rows = numbers ? ["1234567890", "@#%&*()-+=", ".,!?/:;_'\""] : ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
        for (index, row) in letterRows.enumerated() { row.arrangedSubviews.forEach { $0.removeFromSuperview() }; for character in rows[index] { let text = shifted ? String(character).uppercased() : String(character); row.addArrangedSubview(button(text) { [weak self] in self?.type(text) }) } }
    }
    private func updateQuery() { queryButton.setTitle("Search: " + query, for: .normal) }
    private func type(_ text: String) { if let field { values[field, default: ""] += text; showSelection() } else { query += text; list() }; updateQuery() }
    private func erase() { if let field { if !(values[field] ?? "").isEmpty { values[field]?.removeLast() }; showSelection() } else { if !query.isEmpty { query.removeLast() }; list() }; updateQuery() }
    private func refresh() {
        do { snapshot = try TypeRelayCore.execute(["action": "keyboard"], keyboard: true)["data"] as? [String: Any] ?? [:]; status.text = ""; selection = nil; list(); updateQuery() }
        catch { clearResults(); status.text = "Open TypeRelay and sync your snippets. " + error.localizedDescription }
    }
    private func chooseLibrary() { selection = nil; field = nil; clearResults(); results.addArrangedSubview(button("All libraries") { [weak self] in self?.library = ""; self?.list() }); for item in snapshot["libraries"] as? [[String: Any]] ?? [] { let id = item["_id"] as? String ?? ""; results.addArrangedSubview(button(item["name"] as? String ?? "Library") { [weak self] in self?.library = id; self?.list() }) } }
    private func list() {
        selection = nil; field = nil; clearResults(); var count = 0
        for item in snapshot["libraries"] as? [[String: Any]] ?? [] where library.isEmpty || item["_id"] as? String == library {
            for record in item["records"] as? [[String: Any]] ?? [] {
                let content = record["content"] as? [String: Any] ?? [:]
                let title = (record["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? record["trigger"] as? String ?? "Untitled snippet"
                let searchable = [title, record["trigger"] as? String ?? "", content["text"] as? String ?? ""].joined(separator: " ")
                if !query.isEmpty && !searchable.localizedCaseInsensitiveContains(query) { continue }; count += 1; if count > 60 { continue }
                results.addArrangedSubview(button(title) { [weak self] in guard let self else { return }; self.selection = record; self.selectionLibrary = item["_id"] as? String ?? ""; self.values = [:]; self.field = nil; self.showSelection() })
            }
        }
        status.text = count == 0 ? "No snippets. Open TypeRelay to sync." : count > 60 ? "Showing 60 matches. Refine your search." : "Tap a snippet to preview and insert."
    }
    private func render(preview: Bool) throws -> [String: Any] { try TypeRelayCore.execute(["action": "keyboard_render", "generation": snapshot["generation"] ?? "", "library": selectionLibrary, "id": selection?["id"] ?? "", "values": values, "preview": preview], keyboard: true)["data"] as? [String: Any] ?? [:] }
    private func showSelection() {
        guard selection != nil else { return }; clearResults()
        do {
            let rendered = try render(preview: true)
            let definitions = rendered["variables"] as? [String: [String: Any]] ?? (rendered["template"] as? [String: Any])?["variables"] as? [String: [String: Any]] ?? [:]
            for name in rendered["fields"] as? [String] ?? [] { let definition = definitions[name] ?? [:]; if values[name] == nil { values[name] = definition["default"] as? String ?? "" }; let label = definition["label"] as? String ?? name; results.addArrangedSubview(button((field == name ? "● " : "") + (label.isEmpty ? name : label) + ": " + (values[name] ?? "")) { [weak self] in self?.field = name; self?.showSelection() }) }
            let preview = UILabel(); preview.numberOfLines = 4; preview.font = .preferredFont(forTextStyle: .caption1); preview.text = rendered["text"] as? String; results.addArrangedSubview(preview)
            let insert = button("Insert text") { [weak self] in self?.insert() }; insert.isEnabled = (rendered["enter_actions"] as? Int ?? 0) == 0; results.addArrangedSubview(insert)
            status.text = insert.isEnabled ? "iOS inserts plain text. Use TypeRelay for rich copy." : "Desktop Enter actions cannot run on mobile."
        } catch { status.text = error.localizedDescription }
    }
    private func insert() { do { let rendered = try render(preview: false); guard (rendered["enter_actions"] as? Int ?? 0) == 0 else { return }; textDocumentProxy.insertText(rendered["text"] as? String ?? ""); values.removeAll(); selection = nil; field = nil; list() } catch { status.text = error.localizedDescription } }
}
