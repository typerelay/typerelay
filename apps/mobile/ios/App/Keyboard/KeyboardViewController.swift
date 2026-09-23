import UIKit

final class KeyboardViewController: UIInputViewController {
    private enum KeyboardMode { case typing, search, preview, fieldEditing }
    private struct SnippetMatch { let id: String; let library: String; let title: String; let trigger: String; let preview: String }
    private var stack = UIStackView()
    private var typingStack = UIStackView()
    private var overlayStack = UIStackView()
    private var overlayBody = UIStackView()
    private var overlayFooter = UIStackView()
    private var resultListScroll = UIScrollView()
    private var searchResultsStack = UIStackView()
    private var previewScroll = UIScrollView()
    private var strip = UIStackView()
    private var searchPanel = UIStackView()
    private var candidateScroll = UIScrollView()
    private var candidateRow = UIStackView()
    private var searchButton = UIButton(type: .system)
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
    private var fragment = ""
    private var anchorContext: String?
    private var anchorAfter: String?
    private var anchorDocument = ""
    private var anchorFragment = ""
    private var anchorValid = false
    private var changingHost = false
    private var mode = KeyboardMode.typing
    private var browseAll = false
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
        queryButton = button("") {}; queryButton.contentHorizontalAlignment = .leading
        queryButton.heightAnchor.constraint(equalToConstant: 34).isActive = true
        strip.axis = .horizontal; strip.spacing = 6; typingStack.addArrangedSubview(strip)
        strip.heightAnchor.constraint(equalToConstant: 42).isActive = true
        searchButton.setImage(UIImage(systemName: "magnifyingglass"), for: .normal); searchButton.setPreferredSymbolConfiguration(UIImage.SymbolConfiguration(pointSize: 24, weight: .semibold), forImageIn: .normal); searchButton.tintColor = view.tintColor; searchButton.backgroundColor = view.tintColor.withAlphaComponent(0.18); searchButton.layer.cornerRadius = 21; searchButton.accessibilityLabel = "Search snippets"; searchButton.widthAnchor.constraint(equalToConstant: 44).isActive = true; searchButton.addAction(UIAction { [weak self] _ in self?.showSearch(browse: false) }, for: .touchUpInside); strip.addArrangedSubview(searchButton)
        candidateRow.axis = .horizontal; candidateRow.spacing = 4; candidateRow.translatesAutoresizingMaskIntoConstraints = false; candidateScroll.showsHorizontalScrollIndicator = false; candidateScroll.addSubview(candidateRow)
        NSLayoutConstraint.activate([candidateRow.leadingAnchor.constraint(equalTo: candidateScroll.contentLayoutGuide.leadingAnchor), candidateRow.trailingAnchor.constraint(equalTo: candidateScroll.contentLayoutGuide.trailingAnchor), candidateRow.topAnchor.constraint(equalTo: candidateScroll.contentLayoutGuide.topAnchor), candidateRow.bottomAnchor.constraint(equalTo: candidateScroll.contentLayoutGuide.bottomAnchor), candidateRow.heightAnchor.constraint(equalTo: candidateScroll.frameLayoutGuide.heightAnchor)])
        strip.addArrangedSubview(candidateScroll)
        let divider = UIView(); divider.backgroundColor = color(light: .systemGray3, dark: .systemGray); divider.widthAnchor.constraint(equalToConstant: 1).isActive = true; strip.addArrangedSubview(divider)
        allButton = UIButton(type: .system); allButton.widthAnchor.constraint(equalToConstant: 64).isActive = true; strip.addArrangedSubview(allButton)
        searchPanel.axis = .vertical; searchPanel.spacing = 4; searchPanel.isHidden = true; typingStack.addArrangedSubview(searchPanel)
        let searchHeader = UIStackView(); searchHeader.axis = .horizontal; searchHeader.spacing = 6; searchHeader.heightAnchor.constraint(equalToConstant: 44).isActive = true
        let searchBack = button("Back") { [weak self] in self?.showTyping() }; searchBack.widthAnchor.constraint(equalToConstant: 86).isActive = true; searchHeader.addArrangedSubview(searchBack); searchHeader.addArrangedSubview(UIView()); searchPanel.addArrangedSubview(searchHeader)
        searchPanel.addArrangedSubview(queryButton)
        resultListScroll.heightAnchor.constraint(equalToConstant: 150).isActive = true; searchPanel.addArrangedSubview(resultListScroll)
        searchResultsStack.axis = .vertical; searchResultsStack.spacing = 4; searchResultsStack.translatesAutoresizingMaskIntoConstraints = false; resultListScroll.addSubview(searchResultsStack)
        NSLayoutConstraint.activate([searchResultsStack.leadingAnchor.constraint(equalTo: resultListScroll.contentLayoutGuide.leadingAnchor), searchResultsStack.trailingAnchor.constraint(equalTo: resultListScroll.contentLayoutGuide.trailingAnchor), searchResultsStack.topAnchor.constraint(equalTo: resultListScroll.contentLayoutGuide.topAnchor), searchResultsStack.bottomAnchor.constraint(equalTo: resultListScroll.contentLayoutGuide.bottomAnchor), searchResultsStack.widthAnchor.constraint(equalTo: resultListScroll.frameLayoutGuide.widthAnchor)])
        status.font = .preferredFont(forTextStyle: .caption1); status.numberOfLines = 2; status.isHidden = true; typingStack.addArrangedSubview(status)
        keyStack.axis = .vertical; keyStack.spacing = 6; typingStack.addArrangedSubview(keyStack)
        for _ in 0..<3 { let row = UIStackView(); row.distribution = .fillEqually; row.spacing = 6; row.heightAnchor.constraint(equalToConstant: 44).isActive = true; letterRows.append(row); keyStack.addArrangedSubview(row) }
        controls.distribution = .fill; controls.spacing = 6; controls.heightAnchor.constraint(equalToConstant: 44).isActive = true; keyStack.addArrangedSubview(controls)
        overlayStack.axis = .vertical; overlayStack.spacing = 4; overlayStack.isHidden = true; stack.addArrangedSubview(overlayStack)
        keys(); updateLayout()
    }
    override func viewWillAppear(_ animated: Bool) { super.viewWillAppear(animated); refresh() }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); values.removeAll(); selection = nil; field = nil; query = ""; matches = []; anchorValid = false; mode = .typing }
    override func textDidChange(_ textInput: UITextInput?) { super.textDidChange(textInput); if !changingHost { if mode == .typing { updateMatches() } else if !validAnchor() { anchorValid = false } } }
    override func selectionDidChange(_ textInput: UITextInput?) { super.selectionDidChange(textInput); if !changingHost { if mode == .typing { updateMatches() } else if !validAnchor() { anchorValid = false } } }
    private func button(_ title: String, action: @escaping () -> Void) -> UIButton { let button = UIButton(type: .system); button.setTitle(title, for: .normal); button.addAction(UIAction { _ in action() }, for: .touchUpInside); return button }
    private func choiceButton(_ title: String, action: @escaping () -> Void) -> UIButton { let button = self.button(title, action: action); button.backgroundColor = color(light: .systemGray5, dark: .systemGray4); button.setTitleColor(.label, for: .normal); button.contentHorizontalAlignment = .leading; button.titleLabel?.lineBreakMode = .byTruncatingTail; button.layer.cornerRadius = 6; return button }
    private func color(light: UIColor, dark: UIColor) -> UIColor { UIColor { $0.userInterfaceStyle == .dark ? dark : light } }
    private func key(_ title: String, special: Bool = false, action: @escaping () -> Void) -> UIButton { let key = button(title, action: action); key.backgroundColor = special ? color(light: .systemGray4, dark: .systemGray3) : color(light: .white, dark: .systemGray2); key.setTitleColor(.label, for: .normal); key.titleLabel?.font = .systemFont(ofSize: special ? 16 : 22, weight: .regular); key.layer.cornerRadius = 6; key.layer.shadowColor = UIColor.black.cgColor; key.layer.shadowOpacity = 0.18; key.layer.shadowOffset = CGSize(width: 0, height: 1); key.layer.shadowRadius = 0.5; return key }
    private func removeArrangedSubviews(_ stack: UIStackView) { stack.arrangedSubviews.forEach { stack.removeArrangedSubview($0); $0.removeFromSuperview() } }
    private func setAllAction(_ title: String, action: @escaping () -> Void) { allButton.removeAction(identifiedBy: UIAction.Identifier("primary"), for: .touchUpInside); allButton.setTitle(title, for: .normal); allButton.addAction(UIAction(identifier: UIAction.Identifier("primary")) { _ in action() }, for: .touchUpInside) }
    private func updateLayout() {
        let target: CGFloat
        switch mode {
        case .typing: target = 300
        case .search: target = 450
        case .fieldEditing: target = 300
        case .preview: target = 360
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
        if mode == .fieldEditing, let field { values[field, default: ""] += text; updateFieldHeader(); return }
        if mode == .search { if text != "\n" { query += text; updateSearch() }; return }
        changingHost = true; textDocumentProxy.insertText(text); changingHost = false
        updateMatches(autoExpand: text.count == 1 && (text.first?.isLetter == true || text.first?.isNumber == true || text == "-"))
    }
    private func erase() {
        if mode == .fieldEditing, let field { if !(values[field] ?? "").isEmpty { values[field]?.removeLast() }; updateFieldHeader(); return }
        if mode == .search { if !query.isEmpty { query.removeLast() }; updateSearch(); return }
        changingHost = true; textDocumentProxy.deleteBackward(); changingHost = false; updateMatches()
    }
    private func refresh() {
        do { snapshot = try TypeRelayCore.execute(["action": "keyboard"], keyboard: true)["data"] as? [String: Any] ?? [:]; selection = nil; values.removeAll(); showTyping() }
        catch { matches = []; showTyping(update: false); status.text = "Open TypeRelay and sync your snippets. " + error.localizedDescription; status.isHidden = false }
    }
    private func context() -> String? { textDocumentProxy.documentContextBeforeInput.map { String($0.suffix(128)) } }
    private func afterContext() -> String? { textDocumentProxy.documentContextAfterInput.map { String($0.prefix(128)) } }
    private func captureAnchor(_ part: String) { anchorContext = context(); anchorAfter = afterContext(); anchorDocument = String(describing: textDocumentProxy.documentIdentifier); anchorFragment = part; anchorValid = anchorContext?.lowercased().hasSuffix(part.lowercased()) == true && (textDocumentProxy.selectedText?.isEmpty ?? true) }
    private func validAnchor() -> Bool { anchorValid && anchorDocument == String(describing: textDocumentProxy.documentIdentifier) && context() == anchorContext && afterContext() == anchorAfter && (textDocumentProxy.selectedText?.isEmpty ?? true) }
    private func matchRequest(_ kind: String, _ input: String) throws -> [String: Any] { var request: [String: Any] = ["action": "keyboard_matches", "generation": snapshot["generation"] ?? "", "mode": kind]; request[kind == "typing" ? "context" : "query"] = input; return try TypeRelayCore.execute(request, keyboard: true)["data"] as? [String: Any] ?? [:] }
    private func parseMatch(_ value: [String: Any]) -> SnippetMatch { SnippetMatch(id: value["id"] as? String ?? "", library: value["library"] as? String ?? "", title: value["title"] as? String ?? "", trigger: value["trigger"] as? String ?? "", preview: value["preview"] as? String ?? "") }
    private func resultRow(_ match: SnippetMatch) -> UIButton {
        let label = match.trigger.isEmpty ? match.title : match.trigger
        let row = choiceButton("") { [weak self] in self?.select(match, returnMode: .search) }; row.isAccessibilityElement = true; row.accessibilityLabel = "\(label), \(match.preview)"
        let content = UIStackView(); content.axis = .horizontal; content.alignment = .center; content.spacing = 8; content.isUserInteractionEnabled = false; content.translatesAutoresizingMaskIntoConstraints = false
        let abbreviation = UILabel(); abbreviation.text = label; abbreviation.textColor = .label; abbreviation.font = .systemFont(ofSize: 16, weight: .semibold); abbreviation.numberOfLines = 1; abbreviation.lineBreakMode = .byTruncatingTail; abbreviation.widthAnchor.constraint(lessThanOrEqualToConstant: 120).isActive = true; abbreviation.setContentCompressionResistancePriority(.required, for: .horizontal); content.addArrangedSubview(abbreviation)
        let dash = UILabel(); dash.text = "—"; dash.textColor = .secondaryLabel; dash.setContentCompressionResistancePriority(.required, for: .horizontal); content.addArrangedSubview(dash)
        let preview = UILabel(); preview.text = match.preview; preview.textColor = .label; preview.font = .preferredFont(forTextStyle: .body); preview.numberOfLines = 1; preview.lineBreakMode = .byTruncatingTail; preview.setContentCompressionResistancePriority(.defaultLow, for: .horizontal); content.addArrangedSubview(preview)
        row.addSubview(content); NSLayoutConstraint.activate([content.leadingAnchor.constraint(equalTo: row.leadingAnchor, constant: 12), content.trailingAnchor.constraint(equalTo: row.trailingAnchor, constant: -12), content.centerYAnchor.constraint(equalTo: row.centerYAnchor)])
        return row
    }
    private func recordFor(_ match: SnippetMatch) -> [String: Any]? { for library in snapshot["libraries"] as? [[String: Any]] ?? [] where library["_id"] as? String == match.library { return (library["records"] as? [[String: Any]] ?? []).first { $0["id"] as? String == match.id } }; return nil }
    private func updateMatches(autoExpand: Bool = false) {
        guard mode == .typing else { return }
        if textDocumentProxy.isSecureTextEntry { matches = []; fragment = ""; strip.isHidden = true; status.isHidden = true; updateLayout(); return }
        removeArrangedSubviews(candidateRow); status.isHidden = true; strip.isHidden = false; candidateScroll.isHidden = false
        setAllAction("All") { [weak self] in self?.showSearch(browse: true) }
        do {
            let result = try matchRequest("typing", context() ?? ""); fragment = result["fragment"] as? String ?? ""
            matches = (result["matches"] as? [[String: Any]] ?? []).map(parseMatch)
            for match in matches { let item = choiceButton("\(match.trigger)  \(match.title)") { [weak self] in self?.select(match, returnMode: .typing) }; item.widthAnchor.constraint(equalToConstant: 148).isActive = true; candidateRow.addArrangedSubview(item) }
            if autoExpand, let exact = result["exact"] as? [String: Any] { select(parseMatch(exact), returnMode: .typing) }
        } catch { status.text = error.localizedDescription; status.isHidden = false }
        updateLayout()
    }
    private func showTyping(update: Bool = true) { mode = .typing; selection = nil; field = nil; anchorValid = false; browseAll = false; query = ""; typingStack.isHidden = false; overlayStack.isHidden = true; searchPanel.isHidden = true; if update { updateMatches() } else { updateLayout() } }
    private func showSearch(browse: Bool, newSearch: Bool = true) {
        guard !textDocumentProxy.isSecureTextEntry else { return }
        if newSearch { captureAnchor(fragment); browseAll = browse; query = "" }
        mode = .search; selection = nil; field = nil; typingStack.isHidden = false; overlayStack.isHidden = true; searchPanel.isHidden = false; strip.isHidden = true
        updateSearch(); updateLayout()
    }
    private func updateSearch() {
        guard mode == .search else { return }
        queryButton.setTitle("Search: \(query)", for: .normal); removeArrangedSubviews(searchResultsStack)
        do {
            if query.isEmpty && !browseAll { let prompt = UILabel(); prompt.text = "Type to search snippets"; prompt.textColor = .secondaryLabel; prompt.font = .preferredFont(forTextStyle: .body); searchResultsStack.addArrangedSubview(prompt); status.isHidden = true; return }
            let result = try matchRequest("search", query)
            for value in result["matches"] as? [[String: Any]] ?? [] { let item = resultRow(parseMatch(value)); item.heightAnchor.constraint(equalToConstant: 44).isActive = true; searchResultsStack.addArrangedSubview(item) }
            if result["truncated"] as? Bool == true { let note = UILabel(); note.text = "Refine search to see more"; note.font = .preferredFont(forTextStyle: .caption1); searchResultsStack.addArrangedSubview(note) }
            status.isHidden = true
        } catch { status.text = error.localizedDescription; status.isHidden = false }
    }
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
    private func select(_ match: SnippetMatch, returnMode: KeyboardMode) {
        guard !textDocumentProxy.isSecureTextEntry else { return }
        if returnMode == .typing { captureAnchor(fragment) }
        guard validAnchor() else { if mode == .search { showTyping() }; status.text = "Text changed. Select the snippet again."; status.isHidden = false; return }
        guard let record = recordFor(match) else { return }
        selection = record; selectionLibrary = match.library; values.removeAll(); previewReturnMode = returnMode
        do { let rendered = try render(preview: true); if !(rendered["fields"] as? [String] ?? []).isEmpty || rendered["html"] != nil || !(rendered["assets"] as? [String] ?? []).isEmpty || (rendered["enter_actions"] as? Int ?? 0) != 0 { showPreview() } else { insert() } }
        catch { status.text = error.localizedDescription; status.isHidden = false }
    }
    private func render(preview: Bool) throws -> [String: Any] { try TypeRelayCore.execute(["action": "keyboard_render", "generation": snapshot["generation"] ?? "", "library": selectionLibrary, "id": selection?["id"] ?? "", "values": values, "preview": preview], keyboard: true)["data"] as? [String: Any] ?? [:] }
    private func showPreview(message: String? = nil) {
        guard let selection else { return showTyping() }
        mode = .preview; field = nil
        let title = (selection["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? selection["trigger"] as? String ?? "Snippet preview"
        prepareOverlay(title: title) { [weak self] in guard let self else { return }; if self.previewReturnMode == .search { self.showSearch(browse: self.browseAll, newSearch: false) } else { self.showTyping() } }
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
        mode = .fieldEditing; field = name; fieldLabel = label; typingStack.isHidden = false; overlayStack.isHidden = true; searchPanel.isHidden = true; candidateScroll.isHidden = false; strip.isHidden = false; status.isHidden = true; removeArrangedSubviews(candidateRow)
        fieldButton = choiceButton("") {}; fieldButton.widthAnchor.constraint(equalToConstant: 260).isActive = true; candidateRow.addArrangedSubview(fieldButton); updateFieldHeader()
        setAllAction("Done") { [weak self] in self?.showPreview() }; updateLayout()
    }
    private func updateFieldHeader() { guard let field else { return }; fieldButton.setTitle("\(fieldLabel): \(values[field] ?? "")", for: .normal) }
    private func insert() {
        do {
            let rendered = try render(preview: false)
            guard (rendered["enter_actions"] as? Int ?? 0) == 0, !textDocumentProxy.isSecureTextEntry else { return }
            guard validAnchor() else { throw NSError(domain: "TypeRelay", code: 1, userInfo: [NSLocalizedDescriptionKey: "Text changed. Select the snippet again."]) }
            changingHost = true
            for _ in anchorFragment { textDocumentProxy.deleteBackward() }
            textDocumentProxy.insertText(rendered["text"] as? String ?? "")
            changingHost = false
            values.removeAll(); selection = nil; field = nil; showTyping()
        } catch { changingHost = false; showPreview(message: error.localizedDescription) }
    }
}
