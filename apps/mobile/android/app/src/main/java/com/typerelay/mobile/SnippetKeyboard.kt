package com.typerelay.mobile

import android.content.ClipDescription
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.inputmethodservice.InputMethodService
import android.os.Build
import android.text.Html
import android.text.InputType
import android.util.Base64
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputContentInfo
import android.view.inputmethod.InputConnection
import android.widget.*
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class SnippetKeyboard: InputMethodService() {
	private enum class KeyboardMode { TYPING, SEARCH, PREVIEW, FIELD_EDITING }
	private data class SnippetMatch(val id: String, val library: String, val title: String, val trigger: String)
	private data class KeyboardPalette(val surface: Int, val key: Int, val special: Int, val text: Int, val muted: Int, val specialText: Int)
	private lateinit var palette: KeyboardPalette
	private lateinit var root: FrameLayout
	private lateinit var typingLayer: LinearLayout
	private lateinit var overlayLayer: LinearLayout
	private lateinit var overlayBody: LinearLayout
	private lateinit var overlayFooter: LinearLayout
	private lateinit var candidateStrip: LinearLayout
	private lateinit var candidateScroll: HorizontalScrollView
	private lateinit var allDivider: View
	private lateinit var allButton: Button
	private lateinit var searchPanel: LinearLayout
	private lateinit var search: EditText
	private lateinit var status: TextView
	private lateinit var keys: LinearLayout
	private lateinit var resultListScroll: ScrollView
	private lateinit var previewScroll: ScrollView
	private var snapshot = JSONObject()
	private var selected: JSONObject? = null
	private var selectedLibrary = ""
	private var values = JSONObject()
	private var activeField: EditText? = null
	private var matches = emptyList<SnippetMatch>()
	private var fragment = ""
	private var anchorContext: String? = null
	private var anchorAfter: String? = null
	private var anchorFragment = ""
	private var anchorValid = false
	private var lastSelectionStart = -1
	private var lastSelectionEnd = -1
	private var mode = KeyboardMode.TYPING
	private var previewReturnMode = KeyboardMode.TYPING
	private var shifted = false
	private var numbers = false
	private var blocked = false
	private var editingField: Triple<String, String, Boolean>? = null
	override fun onCreateInputView(): View {
		palette = keyboardPalette()
		root = FrameLayout(this).apply { setBackgroundColor(palette.surface); clipChildren = true }
		typingLayer = column(); root.addView(typingLayer, FrameLayout.LayoutParams(-1, -2))
		val stripRow = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
		candidateScroll = HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; candidateStrip = LinearLayout(this@SnippetKeyboard).apply { gravity = Gravity.CENTER_VERTICAL }; addView(candidateStrip, ViewGroup.LayoutParams(-2, dp(48))) }
		stripRow.addView(candidateScroll, LinearLayout.LayoutParams(0, dp(48), 1f))
		allDivider = View(this).apply { setBackgroundColor(palette.muted) }; stripRow.addView(allDivider, LinearLayout.LayoutParams(dp(1), dp(24)).apply { marginStart = dp(8); marginEnd = dp(8) })
		allButton = button("All") { showSearch() }; styleAllButton(); stripRow.addView(allButton, LinearLayout.LayoutParams(dp(64), dp(44)))
		typingLayer.addView(stripRow)
		searchPanel = column().apply { visibility = View.GONE }
		search = input("Snippet search")
		search.addTextChangedListener(object: android.text.TextWatcher {
			override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
			override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { if (mode == KeyboardMode.SEARCH) updateSearch() }
			override fun afterTextChanged(s: android.text.Editable?) {}
		})
		searchPanel.addView(search, LinearLayout.LayoutParams(-1, dp(42)))
		resultListScroll = ScrollView(this)
		searchPanel.addView(resultListScroll, LinearLayout.LayoutParams(-1, dp(156)))
		typingLayer.addView(searchPanel)
		status = TextView(this).apply { visibility = View.GONE; setTextColor(palette.muted); setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f); maxLines = 2; setPadding(dp(4), 0, dp(4), 0) }; typingLayer.addView(status)
		keys = column().apply { setPadding(dp(2), dp(2), dp(2), dp(2)) }; typingLayer.addView(keys); drawKeys()
		overlayLayer = column().apply { visibility = View.GONE }
		root.addView(overlayLayer, FrameLayout.LayoutParams(-1, dp(300)))
		applySafeArea()
		styleNavigation()
		return root
	}
	override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
		super.onStartInputView(info, restarting)
		val variation = (info?.inputType ?: 0) and InputType.TYPE_MASK_VARIATION
		val type = (info?.inputType ?: 0) and InputType.TYPE_MASK_CLASS
		blocked = (type == InputType.TYPE_CLASS_TEXT && variation in listOf(InputType.TYPE_TEXT_VARIATION_PASSWORD, InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD, InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)) || (type == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
		lastSelectionStart = info?.initialSelStart ?: -1; lastSelectionEnd = info?.initialSelEnd ?: -1
		anchorValid = false; search.setText("")
		refresh()
		styleNavigation()
		ViewCompat.requestApplyInsets(root)
	}
	override fun onWindowShown() { super.onWindowShown(); if (::root.isInitialized) styleNavigation() }
	override fun onFinishInputView(finishingInput: Boolean) { super.onFinishInputView(finishingInput); values = JSONObject(); selected = null; snapshot = JSONObject(); activeField = null; matches = emptyList(); fragment = ""; anchorValid = false; mode = KeyboardMode.TYPING }
	override fun onUpdateSelection(oldSelStart: Int, oldSelEnd: Int, newSelStart: Int, newSelEnd: Int, candidatesStart: Int, candidatesEnd: Int) {
		super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)
		if (mode != KeyboardMode.TYPING && (hostContext() != anchorContext || hostAfter() != anchorAfter || newSelStart != newSelEnd)) anchorValid = false
		lastSelectionStart = newSelStart; lastSelectionEnd = newSelEnd
		if (mode == KeyboardMode.TYPING && ::root.isInitialized) updateMatches()
	}
	override fun onConfigurationChanged(newConfig: Configuration) { super.onConfigurationChanged(newConfig); palette = keyboardPalette(); if (::root.isInitialized) { root.setBackgroundColor(palette.surface); styleInput(search); styleAllButton(); allDivider.setBackgroundColor(palette.muted); styleNavigation(); status.setTextColor(palette.muted); drawKeys(); renderMode(); ViewCompat.requestApplyInsets(root) } }
	private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
	private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(4), dp(2), dp(4), dp(2)) }
	private fun rounded(color: Int) = GradientDrawable().apply { cornerRadius = dp(6).toFloat(); setColor(color) }
	private fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; isAllCaps = false; minWidth = 0; minimumWidth = 0; minHeight = 0; minimumHeight = 0; background = rounded(palette.key); elevation = 0f; setTextColor(palette.text); setPadding(dp(6), 0, dp(6), 0); setOnClickListener { action() } }
	private fun styleAllButton() { allButton.background = rounded(palette.surface); allButton.elevation = 0f; allButton.setTextColor(palette.muted) }
	private fun styleInput(field: EditText) { field.background = rounded(palette.key); field.setTextColor(palette.text); field.setHintTextColor(palette.muted) }
	private fun input(label: String) = EditText(this).apply { contentDescription = label; showSoftInputOnFocus = false; isSingleLine = true; setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f); styleInput(this); setOnFocusChangeListener { _, focused -> if (focused) activeField = this }; setOnClickListener { activeField = this } }
	private fun keyboardPalette(): KeyboardPalette {
		val dark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return if (dark) KeyboardPalette(getColor(android.R.color.system_neutral1_900), getColor(android.R.color.system_neutral1_700), getColor(android.R.color.system_accent2_700), getColor(android.R.color.system_neutral1_50), getColor(android.R.color.system_neutral2_200), getColor(android.R.color.system_accent2_50)) else KeyboardPalette(getColor(android.R.color.system_neutral1_50), Color.WHITE, getColor(android.R.color.system_accent2_100), getColor(android.R.color.system_neutral1_900), getColor(android.R.color.system_neutral2_700), getColor(android.R.color.system_accent2_900))
		return if (dark) KeyboardPalette(Color.rgb(40, 42, 46), Color.rgb(92, 94, 98), Color.rgb(66, 68, 72), Color.WHITE, Color.rgb(210, 214, 220), Color.WHITE) else KeyboardPalette(Color.rgb(239, 241, 235), Color.WHITE, Color.rgb(220, 231, 199), Color.rgb(38, 40, 42), Color.rgb(92, 94, 98), Color.rgb(38, 40, 42))
	}
	private fun styleNavigation() { window.window?.let { bar -> val light = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) != Configuration.UI_MODE_NIGHT_YES; WindowCompat.getInsetsController(bar, root).isAppearanceLightNavigationBars = light && Build.VERSION.SDK_INT >= 26; if (Build.VERSION.SDK_INT < 35) bar.navigationBarColor = if (light && Build.VERSION.SDK_INT < 26) Color.rgb(40, 42, 46) else palette.surface } }
	private fun key(label: String, special: Boolean = false, action: () -> Unit) = button(label, action).apply { val tinted = special && label != "Space"; background = rounded(if (tinted) palette.special else palette.key); gravity = Gravity.CENTER; setTextColor(if (tinted) palette.specialText else palette.text); setTextSize(TypedValue.COMPLEX_UNIT_SP, if (label == "⇧") 26f else if (special || label == "Space") 17f else 24f); typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL); setPadding(0, 0, 0, 0) }
	private fun keyParams(weight: Float = 1f, margin: Int = 3) = LinearLayout.LayoutParams(0, dp(52), weight).apply { setMargins(dp(margin), dp(3), dp(margin), dp(3)) }
	private fun applySafeArea() {
		ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
			val bars = insets.getInsets(WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.mandatorySystemGestures())
			view.setPadding(0, 0, 0, bars.bottom + dp(22))
			insets
		}
		ViewCompat.requestApplyInsets(root)
	}
	private fun erase() {
		if (mode == KeyboardMode.SEARCH || mode == KeyboardMode.FIELD_EDITING) { val field = activeField ?: search; val start = field.selectionStart.coerceAtLeast(0); if (start > 0) { val previous = Character.offsetByCodePoints(field.text, start, -1); field.text.delete(previous, start) }; return }
		val connection = currentInputConnection ?: return
		if (!connection.getSelectedText(0).isNullOrEmpty()) connection.commitText("", 1) else connection.deleteSurroundingTextInCodePoints(1, 0)
		updateMatches()
	}
	private fun drawKeys() {
		keys.removeAllViews()
		val rows = if (numbers) listOf("1234567890", "@#%&*()-+=", ".,!?/:;_'\"") else listOf("qwertyuiop", "asdfghjkl", "zxcvbnm")
		for ((index, text) in rows.withIndex()) {
			val row = LinearLayout(this).apply { gravity = Gravity.CENTER }
			if (!numbers && index == 1) row.addView(View(this), LinearLayout.LayoutParams(0, 1, 0.5f))
			if (!numbers && index == 2) row.addView(key("⇧", true) { shifted = !shifted; drawKeys() }, keyParams(1.35f))
			for (character in text) { val label = if (shifted) character.uppercase() else character.toString(); row.addView(key(label) { type(label) }, keyParams(margin = if (index == 0) 4 else 3)) }
			if (!numbers && index == 2) row.addView(key("⌫", true) { erase() }, keyParams(1.35f))
			if (!numbers && index == 1) row.addView(View(this), LinearLayout.LayoutParams(0, 1, 0.5f))
			keys.addView(row)
		}
		val controls = LinearLayout(this)
		val controlKeys = if (numbers) listOf<Pair<Pair<String, Float>, () -> Unit>>(Pair("ABC", 1.4f) to { numbers = false; drawKeys() }, Pair("Space", 4f) to { type(" ") }, Pair("Delete", 1.4f) to { erase() }, Pair("Return", 1.4f) to { type("\n") }) else listOf(Pair("?123", 1.4f) to { numbers = true; shifted = false; drawKeys() }, Pair(",", 1f) to { type(",") }, Pair("Space", 4f) to { type(" ") }, Pair(".", 1f) to { type(".") }, Pair("Return", 1.4f) to { type("\n") })
		for ((definition, action) in controlKeys) controls.addView(key(definition.first, true, action), keyParams(definition.second))
		keys.addView(controls)
	}
	private fun type(text: String) {
		if (mode == KeyboardMode.SEARCH || mode == KeyboardMode.FIELD_EDITING) { if (mode == KeyboardMode.SEARCH && text == "\n") return; val field = activeField ?: search; field.text.replace(field.selectionStart.coerceAtLeast(0), field.selectionEnd.coerceAtLeast(0), text); return }
		val connection = currentInputConnection ?: return
		if (text == "\n") { val action = currentInputEditorInfo?.imeOptions?.and(EditorInfo.IME_MASK_ACTION) ?: EditorInfo.IME_ACTION_NONE; if (action != EditorInfo.IME_ACTION_NONE && action != EditorInfo.IME_ACTION_UNSPECIFIED) connection.performEditorAction(action) else connection.commitText("\n", 1) }
		else connection.commitText(text, 1)
		updateMatches(text.length == 1 && (text[0].isLetterOrDigit() || text == "-"))
	}
	private fun refresh() {
		try { snapshot = NativeCore.execute(this, JSONObject().put("action", "keyboard"), true).getJSONObject("data"); selected = null; values = JSONObject(); showTyping() }
		catch (error: Exception) { matches = emptyList(); candidateStrip.removeAllViews(); allButton.visibility = View.GONE; showTyping(false); status.text = "Open TypeRelay and sync. ${error.message}"; status.visibility = View.VISIBLE }
	}
	private fun parseMatch(value: JSONObject) = SnippetMatch(value.getString("id"), value.getString("library"), value.optString("title"), value.optString("trigger"))
	private fun matchRequest(kind: String, input: String): JSONObject = NativeCore.execute(this, JSONObject().put("action", "keyboard_matches").put("generation", snapshot.getString("generation")).put("mode", kind).put(if (kind == "typing") "context" else "query", input), true).getJSONObject("data")
	private fun hostContext() = currentInputConnection?.getTextBeforeCursor(128, 0)?.toString()
	private fun hostAfter() = currentInputConnection?.getTextAfterCursor(128, 0)?.toString()
	private fun captureAnchor(part: String) { anchorContext = hostContext(); anchorAfter = hostAfter(); anchorFragment = part; anchorValid = anchorContext != null && currentInputConnection?.getSelectedText(0).isNullOrEmpty() && anchorContext!!.endsWith(part, ignoreCase = true) }
	private fun validAnchor() = anchorValid && hostContext() == anchorContext && hostAfter() == anchorAfter && currentInputConnection?.getSelectedText(0).isNullOrEmpty() && (lastSelectionStart == -1 || lastSelectionStart == lastSelectionEnd)
	private fun recordFor(match: SnippetMatch): JSONObject? { val libraries = snapshot.optJSONArray("libraries") ?: return null; for (index in 0 until libraries.length()) { val library = libraries.getJSONObject(index); if (library.optString("_id") != match.library) continue; val records = library.optJSONArray("records") ?: continue; for (recordIndex in 0 until records.length()) { val record = records.getJSONObject(recordIndex); if (record.optString("id") == match.id) return record } }; return null }
	private fun updateMatches(autoExpand: Boolean = false) {
		if (mode != KeyboardMode.TYPING) return
		candidateStrip.removeAllViews(); status.visibility = View.GONE
		if (blocked) { matches = emptyList(); fragment = ""; candidateScroll.visibility = View.INVISIBLE; allButton.visibility = View.INVISIBLE; allDivider.visibility = View.INVISIBLE; return }
		allButton.visibility = View.VISIBLE; allDivider.visibility = View.VISIBLE; allButton.text = "All"; allButton.setOnClickListener { showSearch() }
		try {
			val result = matchRequest("typing", hostContext() ?: "")
			fragment = result.optString("fragment")
			val found = result.getJSONArray("matches"); matches = (0 until found.length()).map { parseMatch(found.getJSONObject(it)) }
			for (match in matches) candidateStrip.addView(button("${match.trigger}  ${match.title}") { select(match, KeyboardMode.TYPING) }, LinearLayout.LayoutParams(dp(148), dp(44)).apply { marginEnd = dp(4) })
			candidateScroll.visibility = if (matches.isEmpty()) View.INVISIBLE else View.VISIBLE
			if (autoExpand && !result.isNull("exact")) select(parseMatch(result.getJSONObject("exact")), KeyboardMode.TYPING)
		} catch (error: Exception) { candidateScroll.visibility = View.INVISIBLE; status.text = error.message ?: "Snippets unavailable"; status.visibility = View.VISIBLE }
	}
	private fun showTyping(update: Boolean = true) { mode = KeyboardMode.TYPING; selected = null; activeField = null; anchorValid = false; typingLayer.visibility = View.VISIBLE; overlayLayer.visibility = View.GONE; searchPanel.visibility = View.GONE; if (update) updateMatches() }
	private fun showSearch(newSearch: Boolean = true) {
		if (blocked) return
		if (newSearch) captureAnchor(fragment)
		mode = KeyboardMode.SEARCH; selected = null; activeField = search; typingLayer.visibility = View.VISIBLE; overlayLayer.visibility = View.GONE; searchPanel.visibility = View.VISIBLE; candidateScroll.visibility = View.INVISIBLE; allButton.text = "Back"; allButton.setOnClickListener { showTyping() }
		if (newSearch) { search.setText(fragment); search.setSelection(search.text.length) }
		updateSearch()
	}
	private fun updateSearch() {
		if (mode != KeyboardMode.SEARCH) return
		try {
			val result = matchRequest("search", search.text.toString()); val found = result.getJSONArray("matches")
			val list = column(); for (index in 0 until found.length()) { val match = parseMatch(found.getJSONObject(index)); list.addView(button("${match.trigger}  ${match.title}") { select(match, KeyboardMode.SEARCH) }, LinearLayout.LayoutParams(-1, dp(44)).apply { bottomMargin = dp(3) }) }
			if (result.optBoolean("truncated")) list.addView(TextView(this).apply { text = "Refine search to see more"; setTextColor(palette.muted) })
			resultListScroll.removeAllViews(); resultListScroll.addView(list)
		} catch (error: Exception) { resultListScroll.removeAllViews(); status.text = error.message ?: "Search unavailable"; status.visibility = View.VISIBLE }
	}
	private fun renderMode() { when (mode) { KeyboardMode.TYPING -> showTyping(); KeyboardMode.SEARCH -> showSearch(false); KeyboardMode.PREVIEW -> showPreview(); KeyboardMode.FIELD_EDITING -> editingField?.let { showFieldEditing(it.first, it.second, it.third) } ?: showPreview() } }
	private fun prepareOverlay(title: String, back: () -> Unit) {
		overlayLayer.removeAllViews()
		val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
		header.addView(button("← Back", back), LinearLayout.LayoutParams(dp(90), dp(46)))
		header.addView(TextView(this).apply { text = title; setTextColor(palette.text); setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f); maxLines = 1; gravity = Gravity.CENTER_VERTICAL }, LinearLayout.LayoutParams(0, dp(46), 1f))
		overlayLayer.addView(header)
		overlayBody = column(); overlayFooter = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
		typingLayer.visibility = View.GONE; overlayLayer.visibility = View.VISIBLE
	}
	private fun select(match: SnippetMatch, returnMode: KeyboardMode) {
		if (returnMode == KeyboardMode.TYPING) captureAnchor(fragment)
		if (!validAnchor()) { if (mode == KeyboardMode.SEARCH) showTyping(); status.text = "Text changed. Select the snippet again."; status.visibility = View.VISIBLE; return }
		selected = recordFor(match) ?: return; selectedLibrary = match.library; values = JSONObject(); previewReturnMode = returnMode
		try { val rendered = render(true); if ((rendered.optJSONArray("fields")?.length() ?: 0) > 0 || rendered.has("html") || (rendered.optJSONArray("assets")?.length() ?: 0) > 0 || rendered.optInt("enter_actions") != 0) showPreview() else insert(false) }
		catch (error: Exception) { status.text = error.message ?: "This snippet could not be rendered."; status.visibility = View.VISIBLE }
	}
	private fun render(preview: Boolean): JSONObject = NativeCore.execute(this, JSONObject().put("action", "keyboard_render").put("generation", snapshot.getString("generation")).put("library", selectedLibrary).put("id", selected!!.getString("id")).put("values", values).put("preview", preview), true).getJSONObject("data")
	private fun showPreview(message: String? = null, messageIsError: Boolean = true) {
		val record = selected ?: return showTyping()
		mode = KeyboardMode.PREVIEW; activeField = null
		val title = record.optString("title").ifEmpty { record.optString("trigger").ifEmpty { "Snippet preview" } }
		prepareOverlay(title) { if (previewReturnMode == KeyboardMode.SEARCH) showSearch(false) else showTyping() }
		previewScroll = ScrollView(this).apply { isFillViewport = true; addView(overlayBody) }
		try {
			val rendered = render(true); val definitions = rendered.optJSONObject("variables") ?: rendered.optJSONObject("template")?.optJSONObject("variables") ?: JSONObject(); val fields = rendered.optJSONArray("fields") ?: JSONArray()
			for (index in 0 until fields.length()) {
				val name = fields.getString(index); val definition = definitions.optJSONObject(name) ?: JSONObject(); val label = definition.optString("label").ifEmpty { name }
				if (!values.has(name)) values.put(name, definition.optString("default"))
				overlayBody.addView(button("$label: ${values.optString(name)}") { showFieldEditing(name, label, definition.optBoolean("multiline")) }, LinearLayout.LayoutParams(-1, dp(48)))
			}
			if (message != null) overlayBody.addView(TextView(this).apply { text = message; setTextColor(if (messageIsError) Color.RED else palette.muted); setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f); setPadding(dp(8), dp(4), dp(8), dp(4)) })
			overlayBody.addView(TextView(this).apply { text = rendered.optString("text"); setTextColor(palette.text); setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f); setPadding(dp(8), dp(8), dp(8), dp(8)) })
			val supported = rendered.optInt("enter_actions") == 0
			overlayBody.addView(TextView(this).apply { text = if (supported) "Formatting and images depend on the destination app." else "Desktop Enter actions cannot run on mobile."; setTextColor(palette.muted); setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f); setPadding(dp(8), 0, dp(8), dp(4)) })
			overlayFooter.addView(button("Cancel") { values = JSONObject(); showTyping() }, LinearLayout.LayoutParams(0, dp(48), 1f))
			val assets = rendered.optJSONArray("assets") ?: JSONArray()
			if (rendered.has("html") || assets.length() > 0) {
				lateinit var more: Button
				more = button("More") {
					PopupMenu(this, more).apply {
						if (rendered.has("html")) menu.add("Insert formatted text").setOnMenuItemClickListener { insert(true); true }
						for (assetIndex in 0 until assets.length()) { val id = assets.getString(assetIndex); menu.add("Insert image ${assetIndex + 1}").setOnMenuItemClickListener { insertImage(id); true } }
						show()
					}
				}
				more.isEnabled = supported; overlayFooter.addView(more, LinearLayout.LayoutParams(0, dp(48), 1f))
			}
			val insert = button("Insert text") { insert(false) }.apply { isEnabled = supported }
			overlayFooter.addView(insert, LinearLayout.LayoutParams(0, dp(48), 1.4f))
		} catch (error: Exception) {
			overlayBody.addView(TextView(this).apply { text = error.message ?: "This snippet could not be rendered."; setTextColor(palette.text); setPadding(dp(8), dp(8), dp(8), dp(8)) })
			overlayFooter.addView(button("Cancel") { values = JSONObject(); showTyping() }, LinearLayout.LayoutParams(-1, dp(48)))
		}
		overlayLayer.addView(previewScroll, LinearLayout.LayoutParams(-1, 0, 1f)); overlayLayer.addView(overlayFooter)
	}
	private fun showFieldEditing(name: String, label: String, multiline: Boolean) {
		mode = KeyboardMode.FIELD_EDITING; editingField = Triple(name, label, multiline); typingLayer.visibility = View.VISIBLE; overlayLayer.visibility = View.GONE; searchPanel.visibility = View.GONE; candidateStrip.removeAllViews(); candidateScroll.visibility = View.VISIBLE; status.visibility = View.GONE
		val field = input(label).apply { isSingleLine = !multiline; setText(values.optString(name)); setSelection(text.length); addTextChangedListener(object: android.text.TextWatcher { override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}; override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { values.put(name, s.toString()) }; override fun afterTextChanged(s: android.text.Editable?) {} }) }
		candidateStrip.addView(TextView(this).apply { text = label; setTextColor(palette.text); gravity = Gravity.CENTER_VERTICAL; setPadding(dp(4), 0, dp(8), 0) }, LinearLayout.LayoutParams(-2, dp(44)))
		candidateStrip.addView(field, LinearLayout.LayoutParams(dp(220), dp(44))); activeField = field; field.requestFocus()
		allButton.visibility = View.VISIBLE; allButton.text = "Done"; allButton.setOnClickListener { showPreview() }
	}
	private fun insert(rich: Boolean) {
		try {
			val rendered = render(false); if (rendered.optInt("enter_actions") != 0 || blocked) return
			if (!validAnchor()) throw Exception("Text changed. Select the snippet again.")
			val text = if (rich) Html.fromHtml(rendered.getString("html").replace(Regex("<img\\b[^>]*>", RegexOption.IGNORE_CASE), "[Image]"), Html.FROM_HTML_MODE_COMPACT) else rendered.getString("text")
			val connection = currentInputConnection ?: throw Exception("This field cannot accept the snippet.")
			connection.beginBatchEdit()
			try { if (anchorFragment.isNotEmpty() && !connection.deleteSurroundingText(anchorFragment.length, 0)) throw Exception("The abbreviation could not be replaced."); if (!connection.commitText(text, 1)) { if (anchorFragment.isNotEmpty()) connection.commitText(anchorFragment, 1); throw Exception("This field cannot accept the snippet.") } }
			finally { connection.endBatchEdit() }
			selected = null; values = JSONObject(); showTyping()
		} catch (error: Exception) { showPreview(error.message ?: "The snippet could not be inserted.") }
	}
	private fun insertImage(id: String) {
		try {
			if (Build.VERSION.SDK_INT < 25 || blocked) throw Exception("Use copy/paste from TypeRelay for this field.")
			val rendered = render(false); if (rendered.optInt("enter_actions") != 0) return
			require(id.matches(Regex("[a-f0-9]{64}")))
			val data = File(NativeCore.shared(this), "assets/$id").readText(); val mime = data.substringAfter("data:").substringBefore(';')
			if (currentInputEditorInfo.contentMimeTypes?.any { ClipDescription.compareMimeTypes(mime, it) } != true) throw Exception("This app does not accept this image type. Insert plain text instead.")
			val directory = File(cacheDir, "keyboard").apply { mkdirs() }; val extension = when (mime) { "image/png" -> "png"; "image/jpeg" -> "jpg"; "image/webp" -> "webp"; "image/gif" -> "gif"; else -> throw Exception("Unsupported image type") }; val output = File(directory, "$id.$extension"); output.writeBytes(Base64.decode(data.substringAfter(','), Base64.DEFAULT))
			val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", output)
			if (!validAnchor()) throw Exception("Text changed. Select the snippet again.")
			val connection = currentInputConnection ?: throw Exception("This field cannot accept the image.")
			connection.beginBatchEdit()
			try { if (anchorFragment.isNotEmpty() && !connection.deleteSurroundingText(anchorFragment.length, 0)) throw Exception("The abbreviation could not be replaced."); if (!connection.commitContent(InputContentInfo(uri, ClipDescription("TypeRelay image", arrayOf(mime)), null), InputConnection.INPUT_CONTENT_GRANT_READ_URI_PERMISSION, null)) { if (anchorFragment.isNotEmpty()) connection.commitText(anchorFragment, 1); throw Exception("Image insertion was declined. Insert plain text instead.") } }
			finally { connection.endBatchEdit() }
			selected = null; values = JSONObject(); showTyping()
		} catch (error: Exception) { showPreview(error.message ?: "The image could not be inserted.") }
	}
}
