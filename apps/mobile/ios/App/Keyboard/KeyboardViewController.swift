import UIKit

final class KeyboardViewController: UIInputViewController {
    private enum KeyboardMode { case typing, results, preview, fieldEditing }
    private struct SnippetMatch { let record: [String: Any]; let library: String; let title: String }
    private var stack = UIStackView()
    private var typingStack = UIStackView()
    private var overlayStack = UIStackView()
    private var overlayBody = UIStackView()
    private var overlayFooter = UIStackView()
    private var resultListScroll = UIScrollView()
    private var previewScroll = UIScrollView()
    private var strip = UIStackView()
    private var candidateScroll = UIScrollView()
    private var candidateRow = UIStackView()
    private var allButton = UIButton(type: .system)
    private var queryButton = UIButton(type: .system)
    private var fieldButton = UIButton(type: .system)
    private var status = UILabel()
    private var keyStack = UIStackView()
    private var controls = UIStackView()
    private var heightConstraint: NSLayoutConstraint?
    private var snapshot: [String: Any] = [:]
    private var query = ""
    private var selection: [String: Any]?
    private var selectionLibrary = ""
    private var values: [String: String] = [:]
    private var field: String?
    private var fieldLabel = ""
    private var matches: [SnippetMatch] = []
    private var matchCount = 0
    private var mode = KeyboardMode.typing
    private var previewReturnMode = KeyboardMode.typing
    private var shifted = false
    private var numbers = false
    private var letterRows: [UIStackView] = []
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = color(light: UIColor(red: 0.91, green: 0.92, blue: 0.93, alpha: 1), dark: UIColor(red: 0.16, green: 0.17, blue: 0.18, alpha: 1))
        stack.axis = .vertical; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        heightConstraint = view.heightAnchor.constraint(equalToConstant: 260)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8), stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8), stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 4), stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -4), heightConstraint!])
        typingStack.axis = .vertical; typingStack.spacing = 6; stack.addArrangedSubview(typingStack)
        queryButton = button("") {}; queryButton.contentHorizontalAlignment = .leading; queryButton.isHidden = true; typingStack.addArrangedSubview(queryButton)
        queryButton.heightAnchor.constraint(equalToConstant: 34).isActive = true
        strip.axis = .horizontal; strip.spacing = 6; strip.isHidden = true; typingStack.addArrangedSubview(strip)
        strip.heightAnchor.constraint(equalToConstant: 42).isActive = true
        candidateRow.axis = .horizontal; candidateRow.spacing = 4; candidateRow.translatesAutoresizingMaskIntoConstraints = false; candidateScroll.showsHorizontalScrollIndicator = false; candidateScroll.addSubview(candidateRow)
        NSLayoutConstraint.activate([candidateRow.leadingAnchor.constraint(equalTo: candidateScroll.contentLayoutGuide.leadingAnchor), candidateRow.trailingAnchor.constraint(equalTo: candidateScroll.contentLayoutGuide.trailingAnchor), candidateRow.topAnchor.constraint(equalTo: candidateScroll.contentLayoutGuide.topAnchor), candidateRow.bottomAnchor.constraint(equalTo: candidateScroll.contentLayoutGuide.bottomAnchor), candidateRow.heightAnchor.constraint(equalTo: candidateScroll.frameLayoutGuide.heightAnchor)])
        strip.addArrangedSubview(candidateScroll)
        allButton = UIButton(type: .system); allButton.widthAnchor.constraint(equalToConstant: 78).isActive = true; strip.addArrangedSubview(allButton)
        status.font = .preferredFont(forTextStyle: .caption1); status.numberOfLines = 2; typingStack.addArrangedSubview(status)
        keyStack.axis = .vertical; keyStack.spacing = 6; typingStack.addArrangedSubview(keyStack)
        for _ in 0..<3 { let row = UIStackView(); row.distribution = .fillEqually; row.spacing = 6; row.heightAnchor.constraint(equalToConstant: 44).isActive = true; letterRows.append(row); keyStack.addArrangedSubview(row) }
        controls.distribution = .fill; controls.spacing = 6; controls.heightAnchor.constraint(equalToConstant: 44).isActive = true; keyStack.addArrangedSubview(controls)
        overlayStack.axis = .vertical; overlayStack.spacing = 4; overlayStack.isHidden = true; stack.addArrangedSubview(overlayStack)
        keys(); updateLayout()
    }
    override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated); refresh() }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); values.removeAll(); selection = nil; field = nil; query = ""; matches = []; mode = .typing }
    private func button(_ title: String, action: @escaping () -> Void) -> UIButton { let button = UIButton(type: .system); button.setTitle(title, for: .normal); button.addAction(UIAction { _ in action() }, for: .touchUpInside); return button }
    private func choiceButton(_ title: String, action: @escaping () -> Void) -> UIButton { let button = self.button(title, action: action); button.backgroundColor = color(light: .systemGray5, dark: .systemGray4); button.setTitleColor(.label, for: .normal); button.contentHorizontalAlignment = .leading; button.titleLabel?.lineBreakMode = .byTruncatingTail; button.layer.cornerRadius = 6; return button }
    private func color(light: UIColor, dark: UIColor) -> UIColor { UIColor { $0.userInterfaceStyle == .dark ? dark : light } }
    private func key(_ title: String, special: Bool = false, action: @escaping () -> Void) -> UIButton { let key = button(title, action: action); key.backgroundColor = special ? color(light: .systemGray4, dark: .systemGray3) : color(light: .white, dark: .systemGray2); key.setTitleColor(.label, for: .normal); key.titleLabel?.font = .systemFont(ofSize: special ? 16 : 22, weight: .regular); key.layer.cornerRadius = 6; key.layer.shadowColor = UIColor.black.cgColor; key.layer.shadowOpacity = 0.18; key.layer.shadowOffset = CGSize(width: 0, height: 1); key.layer.shadowRadius = 0.5; return key }
    private func removeArrangedSubviews(_ stack: UIStackView) { stack.arrangedSubviews.forEach { stack.removeArrangedSubview($0); $0.removeFromSuperview() } }
    private func setAllAction(_ title: String, action: @escaping () -> Void) { allButton.removeAction(identifiedBy: UIAction.Identifier("primary"), for: .touchUpInside); allButton.setTitle(title, for: .normal); allButton.addAction(UIAction(identifier: UIAction.Identifier("primary")) { _ in action() }, for: .touchUpInside) }
    private func updateLayout() {
        let target: CGFloat
        switch mode {
        case .typing: target = min(340, (strip.isHidden ? 260 : 300) + (queryButton.isHidden ? 0 : 34))
        case .fieldEditing: target = 300
        case .results, .preview: target = 360
        }
        heightConstraint?.constant = target
    }
    private func keys() {
        let rows = numbers ? ["1234567890", "@#%&*()-+=", ".,!?/:;_'\""] : ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
        for (index, row) in letterRows.enumerated() {
            removeArrangedSubviews(row); row.distribution = .fill
            var characterKeys: [UIButton] = []
            if !numbers && index == 1 { row.addArrangedSubview(UIView()) }
            if !numbers && index == 2 { row.addArrangedSubview(key("⇧", special: true) { [weak self] in guard let self else { return }; self.shifted.toggle(); self.keys() }) }
            for character in rows[index] { let text = shifted ? String(character).uppercased() : String(character); let characterKey = key(text) { [weak self] in self?.type(text) }; characterKeys.append(characterKey); row.addArrangedSubview(characterKey) }
            if !numbers && index == 2 { row.addArrangedSubview(key("⌫", special: true) { [weak self] in self?.erase() }) }
            if !numbers && index == 1 { row.addArrangedSubview(UIView()) }
            if let first = characterKeys.first { for characterKey in characterKeys.dropFirst() { characterKey.widthAnchor.constraint(equalTo: first.widthAnchor).isActive = true }; if !numbers && index == 1 { row.arrangedSubviews.first?.widthAnchor.constraint(equalTo: first.widthAnchor, multiplier: 0.5).isActive = true; row.arrangedSubviews.last?.widthAnchor.constraint(equalTo: first.widthAnchor, multiplier: 0.5).isActive = true }; if !numbers && index == 2 { row.arrangedSubviews.first?.widthAnchor.constraint(equalTo: first.widthAnchor, multiplier: 1.35).isActive = true; row.arrangedSubviews.last?.widthAnchor.constraint(equalTo: first.widthAnchor, multiplier: 1.35).isActive = true } }
        }
        removeArrangedSubviews(controls)
        let mode = key(numbers ? "ABC" : "?123", special: true) { [weak self] in guard let self else { return }; self.numbers.toggle(); self.shifted = false; self.keys() }
        let space = key("Space") { [weak self] in self?.type(" ") }
        let returnKey = key("Return", special: true) { [weak self] in self?.type("\n") }
        controls.addArrangedSubview(mode)
        if numbers { let delete = key("Delete", special: true) { [weak self] in self?.erase() }; controls.addArrangedSubview(space); controls.addArrangedSubview(delete); controls.addArrangedSubview(returnKey); NSLayoutConstraint.activate([mode.widthAnchor.constraint(equalTo: controls.widthAnchor, multiplier: 0.17), delete.widthAnchor.constraint(equalTo: mode.widthAnchor), returnKey.widthAnchor.constraint(equalTo: mode.widthAnchor)]) }
        else { let comma = key(",") { [weak self] in self?.type(",") }; let period = key(".") { [weak self] in self?.type(".") }; controls.addArrangedSubview(comma); controls.addArrangedSubview(space); controls.addArrangedSubview(period); controls.addArrangedSubview(returnKey); NSLayoutConstraint.activate([mode.widthAnchor.constraint(equalTo: controls.widthAnchor, multiplier: 0.17), comma.widthAnchor.constraint(equalTo: controls.widthAnchor, multiplier: 0.11), period.widthAnchor.constraint(equalTo: comma.widthAnchor), returnKey.widthAnchor.constraint(equalTo: mode.widthAnchor)]) }
    }
    private func type(_ text: String) {
        if mode == .fieldEditing, let field { values[field, default: ""] += text; updateFieldHeader() }
        else { query += text; updateMatches() }
    }
    private func erase() {
        if mode == .fieldEditing, let field { if !(values[field] ?? "").isEmpty { values[field]?.removeLast() }; updateFieldHeader() }
        else { if !query.isEmpty { query.removeLast() }; updateMatches() }
    }
    private func refresh() {
        do { snapshot = try TypeRelayCore.execute(["action": "keyboard"], keyboard: true)["data"] as? [String: Any] ?? [:]; selection = nil; values.removeAll(); showTyping() }
        catch { matches = []; matchCount = 0; status.text = "Open TypeRelay and sync your snippets. " + error.localizedDescription; showTyping(update: false) }
    }
    private func findMatches() -> ([SnippetMatch], Int) {
        var found: [SnippetMatch] = []; var count = 0
        for library in snapshot["libraries"] as? [[String: Any]] ?? [] {
            for record in library["records"] as? [[String: Any]] ?? [] {
                let content = record["content"] as? [String: Any] ?? [:]
                let title = (record["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? record["trigger"] as? String ?? "Untitled snippet"
                let searchable = [title, record["trigger"] as? String ?? "", content["text"] as? String ?? ""].joined(separator: " ")
                if !query.isEmpty && !searchable.localizedCaseInsensitiveContains(query) { continue }
                count += 1; if found.count < 60 { found.append(SnippetMatch(record: record, library: library["_id"] as? String ?? "", title: title)) }
            }
        }
        return (found, count)
    }
    private func updateMatches() {
        queryButton.setTitle(query, for: .normal); queryButton.isHidden = query.isEmpty
        removeArrangedSubviews(candidateRow)
        let result = findMatches(); matches = result.0; matchCount = result.1
        for match in matches.prefix(3) { let item = choiceButton(match.title) { [weak self] in self?.select(match, returnMode: .typing) }; item.widthAnchor.constraint(equalToConstant: 128).isActive = true; candidateRow.addArrangedSubview(item) }
        strip.isHidden = matches.isEmpty
        setAllAction("All (\(matchCount))") { [weak self] in self?.showResults() }
        status.text = matchCount == 0 ? "No snippets. Open TypeRelay to sync." : matchCount > 60 ? "Showing 60 matches. Refine your search." : "Tap a match to preview or All to browse."
        updateLayout()
    }
    private func showTyping(update: Bool = true) { mode = .typing; selection = nil; field = nil; typingStack.isHidden = false; overlayStack.isHidden = true; if update { updateMatches() } else { strip.isHidden = true; queryButton.isHidden = query.isEmpty; updateLayout() } }
    private func prepareOverlay(title: String, back: @escaping () -> Void) {
        removeArrangedSubviews(overlayStack)
        let header = UIStackView(); header.axis = .horizontal; header.spacing = 6
        let backButton = button("← Back", action: back); backButton.widthAnchor.constraint(equalToConstant: 86).isActive = true; header.addArrangedSubview(backButton)
        let titleLabel = UILabel(); titleLabel.text = title; titleLabel.font = .preferredFont(forTextStyle: .headline); titleLabel.lineBreakMode = .byTruncatingTail; header.addArrangedSubview(titleLabel); header.heightAnchor.constraint(equalToConstant: 44).isActive = true; overlayStack.addArrangedSubview(header)
        overlayBody = UIStackView(); overlayBody.axis = .vertical; overlayBody.spacing = 4; overlayBody.translatesAutoresizingMaskIntoConstraints = false
        overlayFooter = UIStackView(); overlayFooter.axis = .horizontal; overlayFooter.spacing = 6; overlayFooter.distribution = .fillEqually
        typingStack.isHidden = true; overlayStack.isHidden = false
    }
    private func attach(_ scroll: UIScrollView) {
        scroll.addSubview(overlayBody)
        NSLayoutConstraint.activate([overlayBody.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor), overlayBody.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor), overlayBody.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor), overlayBody.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor), overlayBody.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor)])
        overlayStack.addArrangedSubview(scroll)
    }
    private func showResults() {
        guard !matches.isEmpty else { return }
        mode = .results; selection = nil; field = nil
        prepareOverlay(title: query.isEmpty ? "All snippets" : query) { [weak self] in self?.showTyping() }
        resultListScroll = UIScrollView(); attach(resultListScroll)
        for match in matches { let item = choiceButton(match.title) { [weak self] in self?.select(match, returnMode: .results) }; item.heightAnchor.constraint(equalToConstant: 48).isActive = true; overlayBody.addArrangedSubview(item) }
        let count = UILabel(); count.text = matchCount > 60 ? "Showing 60 of \(matchCount) matches" : "\(matchCount) matches"; count.font = .preferredFont(forTextStyle: .caption1); count.textAlignment = .center; count.heightAnchor.constraint(equalToConstant: 40).isActive = true; overlayFooter.addArrangedSubview(count); overlayStack.addArrangedSubview(overlayFooter); updateLayout()
    }
    private func select(_ match: SnippetMatch, returnMode: KeyboardMode) { selection = match.record; selectionLibrary = match.library; values.removeAll(); previewReturnMode = returnMode; showPreview() }
    private func render(preview: Bool) throws -> [String: Any] { try TypeRelayCore.execute(["action": "keyboard_render", "generation": snapshot["generation"] ?? "", "library": selectionLibrary, "id": selection?["id"] ?? "", "values": values, "preview": preview], keyboard: true)["data"] as? [String: Any] ?? [:] }
    private func showPreview(message: String? = nil) {
        guard let selection else { return showTyping() }
        mode = .preview; field = nil
        let title = (selection["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? selection["trigger"] as? String ?? "Snippet preview"
        prepareOverlay(title: title) { [weak self] in guard let self else { return }; if self.previewReturnMode == .results { self.showResults() } else { self.showTyping() } }
        previewScroll = UIScrollView(); attach(previewScroll)
        do {
            let rendered = try render(preview: true)
            let definitions = rendered["variables"] as? [String: [String: Any]] ?? (rendered["template"] as? [String: Any])?["variables"] as? [String: [String: Any]] ?? [:]
            for name in rendered["fields"] as? [String] ?? [] { let definition = definitions[name] ?? [:]; if values[name] == nil { values[name] = definition["default"] as? String ?? "" }; let label = definition["label"] as? String ?? name; let item = choiceButton((label.isEmpty ? name : label) + ": " + (values[name] ?? "")) { [weak self] in self?.showFieldEditing(name: name, label: label.isEmpty ? name : label) }; item.heightAnchor.constraint(equalToConstant: 48).isActive = true; overlayBody.addArrangedSubview(item) }
            if let message { let warning = UILabel(); warning.text = message; warning.textColor = .systemRed; warning.numberOfLines = 2; warning.font = .preferredFont(forTextStyle: .caption1); overlayBody.addArrangedSubview(warning) }
            let preview = UILabel(); preview.numberOfLines = 0; preview.font = .preferredFont(forTextStyle: .body); preview.text = rendered["text"] as? String; overlayBody.addArrangedSubview(preview)
            let supported = (rendered["enter_actions"] as? Int ?? 0) == 0
            let guidance = UILabel(); guidance.text = supported ? "iOS inserts plain text. Use TypeRelay for rich copy." : "Desktop Enter actions cannot run on mobile."; guidance.font = .preferredFont(forTextStyle: .caption1); guidance.numberOfLines = 2; overlayBody.addArrangedSubview(guidance)
            let cancel = button("Cancel") { [weak self] in self?.values.removeAll(); self?.showTyping() }; overlayFooter.addArrangedSubview(cancel)
            let insert = button("Insert text") { [weak self] in self?.insert() }; insert.isEnabled = supported; overlayFooter.addArrangedSubview(insert)
        } catch {
            let failure = UILabel(); failure.text = error.localizedDescription; failure.numberOfLines = 0; failure.textColor = .systemRed; overlayBody.addArrangedSubview(failure)
            overlayFooter.addArrangedSubview(button("Cancel") { [weak self] in self?.values.removeAll(); self?.showTyping() })
        }
        overlayFooter.heightAnchor.constraint(equalToConstant: 44).isActive = true; overlayStack.addArrangedSubview(overlayFooter); updateLayout()
    }
    private func showFieldEditing(name: String, label: String) {
        mode = .fieldEditing; field = name; fieldLabel = label; typingStack.isHidden = false; overlayStack.isHidden = true; queryButton.isHidden = true; strip.isHidden = false; removeArrangedSubviews(candidateRow)
        fieldButton = choiceButton("") {}; fieldButton.widthAnchor.constraint(equalToConstant: 260).isActive = true; candidateRow.addArrangedSubview(fieldButton); updateFieldHeader()
        setAllAction("Done") { [weak self] in self?.showPreview() }; status.text = "Edit the field, then tap Done."; updateLayout()
    }
    private func updateFieldHeader() { guard let field else { return }; fieldButton.setTitle("\(fieldLabel): \(values[field] ?? "")", for: .normal) }
    private func insert() { do { let rendered = try render(preview: false); guard (rendered["enter_actions"] as? Int ?? 0) == 0 else { return }; textDocumentProxy.insertText(rendered["text"] as? String ?? ""); values.removeAll(); selection = nil; field = nil; showTyping() } catch { showPreview(message: error.localizedDescription) } }
}
