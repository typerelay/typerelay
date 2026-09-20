import UIKit

final class KeyboardViewController: UIInputViewController {
    private var stack = UIStackView()
    private var results = UIStackView()
    private var resultScroll = UIScrollView()
    private var queryButton = UIButton(type: .system)
    private var status = UILabel()
    private var heightConstraint: NSLayoutConstraint?
    private var snapshot: [String: Any] = [:]
    private var query = ""
    private var selection: [String: Any]?
    private var selectionLibrary = ""
    private var values: [String: String] = [:]
    private var field: String?
    private var shifted = false
    private var numbers = false
    private var letterRows: [UIStackView] = []
    private var controls = UIStackView()
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = color(light: UIColor(red: 0.91, green: 0.92, blue: 0.93, alpha: 1), dark: UIColor(red: 0.16, green: 0.17, blue: 0.18, alpha: 1))
        stack.axis = .vertical; stack.spacing = 6; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        heightConstraint = view.heightAnchor.constraint(equalToConstant: 260)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8), stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8), stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 4), stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -4), heightConstraint!])
        queryButton = button("") { [weak self] in self?.field = nil }; queryButton.contentHorizontalAlignment = .leading; queryButton.isHidden = true; stack.addArrangedSubview(queryButton)
        results.axis = .vertical; results.spacing = 4; results.translatesAutoresizingMaskIntoConstraints = false; resultScroll.isHidden = true; resultScroll.addSubview(results)
        NSLayoutConstraint.activate([results.leadingAnchor.constraint(equalTo: resultScroll.contentLayoutGuide.leadingAnchor), results.trailingAnchor.constraint(equalTo: resultScroll.contentLayoutGuide.trailingAnchor), results.topAnchor.constraint(equalTo: resultScroll.contentLayoutGuide.topAnchor), results.bottomAnchor.constraint(equalTo: resultScroll.contentLayoutGuide.bottomAnchor), results.widthAnchor.constraint(equalTo: resultScroll.frameLayoutGuide.widthAnchor)])
        stack.addArrangedSubview(resultScroll)
        status.font = .preferredFont(forTextStyle: .caption1); status.numberOfLines = 2; stack.addArrangedSubview(status)
        for _ in 0..<3 { let row = UIStackView(); row.distribution = .fillEqually; row.spacing = 6; row.heightAnchor.constraint(equalToConstant: 44).isActive = true; letterRows.append(row); stack.addArrangedSubview(row) }
        controls.distribution = .fill; controls.spacing = 6; controls.heightAnchor.constraint(equalToConstant: 44).isActive = true
        stack.addArrangedSubview(controls); keys(); updateLayout()
    }
    override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated); refresh() }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); values.removeAll(); selection = nil; field = nil; query = "" }
    private func button(_ title: String, action: @escaping () -> Void) -> UIButton { let button = UIButton(type: .system); button.setTitle(title, for: .normal); button.addAction(UIAction { _ in action() }, for: .touchUpInside); return button }
    private func color(light: UIColor, dark: UIColor) -> UIColor { UIColor { $0.userInterfaceStyle == .dark ? dark : light } }
    private func key(_ title: String, special: Bool = false, action: @escaping () -> Void) -> UIButton { let key = button(title, action: action); key.backgroundColor = special ? color(light: .systemGray4, dark: .systemGray3) : color(light: .white, dark: .systemGray2); key.setTitleColor(.label, for: .normal); key.titleLabel?.font = .systemFont(ofSize: special ? 16 : 22, weight: .regular); key.layer.cornerRadius = 6; key.layer.shadowColor = UIColor.black.cgColor; key.layer.shadowOpacity = 0.18; key.layer.shadowOffset = CGSize(width: 0, height: 1); key.layer.shadowRadius = 0.5; return key }
    private func clearResults() { results.arrangedSubviews.forEach { $0.removeFromSuperview() }; resultScroll.isHidden = true }
    private func updateLayout() { queryButton.isHidden = query.isEmpty; resultScroll.isHidden = results.arrangedSubviews.isEmpty; status.isHidden = (status.text ?? "").isEmpty; let base: CGFloat = status.isHidden ? 220 : 260; let queryHeight: CGFloat = queryButton.isHidden ? 0 : 34; let resultHeight: CGFloat = resultScroll.isHidden ? 0 : 80; heightConstraint?.constant = min(360, base + queryHeight + resultHeight) }
    private func keys() {
        let rows = numbers ? ["1234567890", "@#%&*()-+=", ".,!?/:;_'\""] : ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
        for (index, row) in letterRows.enumerated() {
            row.arrangedSubviews.forEach { $0.removeFromSuperview() }; row.distribution = .fill
            var characterKeys: [UIButton] = []
            if !numbers && index == 1 { row.addArrangedSubview(UIView()) }
            if !numbers && index == 2 { row.addArrangedSubview(key("⇧", special: true) { [weak self] in guard let self else { return }; self.shifted.toggle(); self.keys() }) }
            for character in rows[index] { let text = shifted ? String(character).uppercased() : String(character); let characterKey = key(text) { [weak self] in self?.type(text) }; characterKeys.append(characterKey); row.addArrangedSubview(characterKey) }
            if !numbers && index == 2 { row.addArrangedSubview(key("⌫", special: true) { [weak self] in self?.erase() }) }
            if !numbers && index == 1 { row.addArrangedSubview(UIView()) }
            if let first = characterKeys.first { for characterKey in characterKeys.dropFirst() { characterKey.widthAnchor.constraint(equalTo: first.widthAnchor).isActive = true }; if !numbers && index == 1 { row.arrangedSubviews.first?.widthAnchor.constraint(equalTo: first.widthAnchor, multiplier: 0.5).isActive = true; row.arrangedSubviews.last?.widthAnchor.constraint(equalTo: first.widthAnchor, multiplier: 0.5).isActive = true }; if !numbers && index == 2 { row.arrangedSubviews.first?.widthAnchor.constraint(equalTo: first.widthAnchor, multiplier: 1.35).isActive = true; row.arrangedSubviews.last?.widthAnchor.constraint(equalTo: first.widthAnchor, multiplier: 1.35).isActive = true } }
        }
        controls.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let mode = key(numbers ? "ABC" : "?123", special: true) { [weak self] in guard let self else { return }; self.numbers.toggle(); self.shifted = false; self.keys() }
        let space = key("Space") { [weak self] in self?.type(" ") }
        let returnKey = key("Return", special: true) { [weak self] in self?.type("\n") }
        controls.addArrangedSubview(mode)
        if numbers { let delete = key("Delete", special: true) { [weak self] in self?.erase() }; controls.addArrangedSubview(space); controls.addArrangedSubview(delete); controls.addArrangedSubview(returnKey); NSLayoutConstraint.activate([mode.widthAnchor.constraint(equalTo: controls.widthAnchor, multiplier: 0.17), delete.widthAnchor.constraint(equalTo: mode.widthAnchor), returnKey.widthAnchor.constraint(equalTo: mode.widthAnchor)]) }
        else { let comma = key(",") { [weak self] in self?.type(",") }; let period = key(".") { [weak self] in self?.type(".") }; controls.addArrangedSubview(comma); controls.addArrangedSubview(space); controls.addArrangedSubview(period); controls.addArrangedSubview(returnKey); NSLayoutConstraint.activate([mode.widthAnchor.constraint(equalTo: controls.widthAnchor, multiplier: 0.17), comma.widthAnchor.constraint(equalTo: controls.widthAnchor, multiplier: 0.11), period.widthAnchor.constraint(equalTo: comma.widthAnchor), returnKey.widthAnchor.constraint(equalTo: mode.widthAnchor)]) }
    }
    private func updateQuery() { queryButton.setTitle(query, for: .normal); updateLayout() }
    private func type(_ text: String) { if let field { values[field, default: ""] += text; showSelection() } else { query += text; list() }; updateQuery() }
    private func erase() { if let field { if !(values[field] ?? "").isEmpty { values[field]?.removeLast() }; showSelection() } else { if !query.isEmpty { query.removeLast() }; list() }; updateQuery() }
    private func refresh() {
        do { snapshot = try TypeRelayCore.execute(["action": "keyboard"], keyboard: true)["data"] as? [String: Any] ?? [:]; status.text = ""; selection = nil; list(); updateQuery() }
        catch { clearResults(); status.text = "Open TypeRelay and sync your snippets. " + error.localizedDescription; updateLayout() }
    }
    private func list() {
        selection = nil; field = nil; clearResults(); var count = 0
        for item in snapshot["libraries"] as? [[String: Any]] ?? [] {
            for record in item["records"] as? [[String: Any]] ?? [] {
                let content = record["content"] as? [String: Any] ?? [:]
                let title = (record["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? record["trigger"] as? String ?? "Untitled snippet"
                let searchable = [title, record["trigger"] as? String ?? "", content["text"] as? String ?? ""].joined(separator: " ")
                if !query.isEmpty && !searchable.localizedCaseInsensitiveContains(query) { continue }; count += 1; if count > 60 { continue }
                results.addArrangedSubview(button(title) { [weak self] in guard let self else { return }; self.selection = record; self.selectionLibrary = item["_id"] as? String ?? ""; self.values = [:]; self.field = nil; self.showSelection() })
            }
        }
        status.text = count == 0 ? "No snippets. Open TypeRelay to sync." : count > 60 ? "Showing 60 matches. Refine your search." : "Tap a snippet to preview and insert."
        updateLayout()
    }
    private func render(preview: Bool) throws -> [String: Any] { try TypeRelayCore.execute(["action": "keyboard_render", "generation": snapshot["generation"] ?? "", "library": selectionLibrary, "id": selection?["id"] ?? "", "values": values, "preview": preview], keyboard: true)["data"] as? [String: Any] ?? [:] }
    private func showSelection() {
        guard selection != nil else { return }; clearResults()
        do {
            results.addArrangedSubview(button("Cancel") { [weak self] in self?.selection = nil; self?.field = nil; self?.values.removeAll(); self?.list() })
            let rendered = try render(preview: true)
            let definitions = rendered["variables"] as? [String: [String: Any]] ?? (rendered["template"] as? [String: Any])?["variables"] as? [String: [String: Any]] ?? [:]
            for name in rendered["fields"] as? [String] ?? [] { let definition = definitions[name] ?? [:]; if values[name] == nil { values[name] = definition["default"] as? String ?? "" }; let label = definition["label"] as? String ?? name; results.addArrangedSubview(button((field == name ? "● " : "") + (label.isEmpty ? name : label) + ": " + (values[name] ?? "")) { [weak self] in self?.field = name; self?.showSelection() }) }
            let preview = UILabel(); preview.numberOfLines = 4; preview.font = .preferredFont(forTextStyle: .caption1); preview.text = rendered["text"] as? String; results.addArrangedSubview(preview)
            let insert = button("Insert text") { [weak self] in self?.insert() }; insert.isEnabled = (rendered["enter_actions"] as? Int ?? 0) == 0; results.addArrangedSubview(insert)
            status.text = insert.isEnabled ? "iOS inserts plain text. Use TypeRelay for rich copy." : "Desktop Enter actions cannot run on mobile."
            updateLayout()
        } catch { status.text = error.localizedDescription; updateLayout() }
    }
    private func insert() { do { let rendered = try render(preview: false); guard (rendered["enter_actions"] as? Int ?? 0) == 0 else { return }; textDocumentProxy.insertText(rendered["text"] as? String ?? ""); values.removeAll(); selection = nil; field = nil; list() } catch { status.text = error.localizedDescription } }
}
