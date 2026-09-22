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
import android.widget.*
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class SnippetKeyboard: InputMethodService() {
	private enum class KeyboardMode { TYPING, RESULTS, PREVIEW, FIELD_EDITING }
	private data class SnippetMatch(val record: JSONObject, val library: String, val title: String)
	private data class KeyboardPalette(val surface: Int, val key: Int, val special: Int, val text: Int, val muted: Int, val specialText: Int)
	private lateinit var palette: KeyboardPalette
	private lateinit var root: FrameLayout
	private lateinit var typingLayer: LinearLayout
	private lateinit var overlayLayer: LinearLayout
	private lateinit var overlayBody: LinearLayout
	private lateinit var overlayFooter: LinearLayout
	private lateinit var candidateStrip: LinearLayout
	private lateinit var candidateScroll: HorizontalScrollView
	private lateinit var allButton: Button
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
	private var matchCount = 0
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
		search = input("Snippet search").apply { visibility = View.GONE }
		search.addTextChangedListener(object: android.text.TextWatcher {
			override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
			override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { if (mode == KeyboardMode.TYPING) updateMatches() }
			override fun afterTextChanged(s: android.text.Editable?) {}
		})
		typingLayer.addView(search, LinearLayout.LayoutParams(-1, dp(42)))
		val stripRow = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
		candidateScroll = HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; candidateStrip = LinearLayout(this@SnippetKeyboard).apply { gravity = Gravity.CENTER_VERTICAL }; addView(candidateStrip, ViewGroup.LayoutParams(-2, dp(48))) }
		stripRow.addView(candidateScroll, LinearLayout.LayoutParams(0, dp(48), 1f))
		allButton = button("All") { showResults() }; styleAllButton(); stripRow.addView(allButton, LinearLayout.LayoutParams(dp(82), dp(44)))
		typingLayer.addView(stripRow)
		status = TextView(this).apply { setTextColor(palette.muted); setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f); maxLines = 2; setPadding(dp(4), 0, dp(4), 0) }; typingLayer.addView(status)
		keys = column(); typingLayer.addView(keys); drawKeys()
		overlayLayer = column().apply { visibility = View.GONE }
		root.addView(overlayLayer, FrameLayout.LayoutParams(-1, dp(300)))
		applySafeArea()
		return root
	}
	override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
		super.onStartInputView(info, restarting)
		val variation = (info?.inputType ?: 0) and InputType.TYPE_MASK_VARIATION
		val type = (info?.inputType ?: 0) and InputType.TYPE_MASK_CLASS
		blocked = (type == InputType.TYPE_CLASS_TEXT && variation in listOf(InputType.TYPE_TEXT_VARIATION_PASSWORD, InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD, InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)) || (type == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
		refresh()
		ViewCompat.requestApplyInsets(root)
	}
	override fun onFinishInputView(finishingInput: Boolean) { super.onFinishInputView(finishingInput); values = JSONObject(); selected = null; snapshot = JSONObject(); activeField = null; matches = emptyList(); mode = KeyboardMode.TYPING }
	override fun onConfigurationChanged(newConfig: Configuration) { super.onConfigurationChanged(newConfig); palette = keyboardPalette(); if (::root.isInitialized) { root.setBackgroundColor(palette.surface); styleInput(search); styleAllButton(); status.setTextColor(palette.muted); drawKeys(); renderMode(); ViewCompat.requestApplyInsets(root) } }
	private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
	private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(4), dp(2), dp(4), dp(2)) }
	private fun rounded(color: Int) = GradientDrawable().apply { cornerRadius = dp(6).toFloat(); setColor(color) }
	private fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; isAllCaps = false; minWidth = 0; minimumWidth = 0; minHeight = 0; minimumHeight = 0; background = rounded(palette.key); elevation = dp(1).toFloat(); setTextColor(palette.text); setPadding(dp(6), 0, dp(6), 0); setOnClickListener { action() } }
	private fun styleAllButton() { allButton.background = rounded(palette.surface); allButton.elevation = 0f; allButton.setTextColor(palette.muted) }
	private fun styleInput(field: EditText) { field.background = rounded(palette.key); field.setTextColor(palette.text); field.setHintTextColor(palette.muted) }
	private fun input(label: String) = EditText(this).apply { contentDescription = label; showSoftInputOnFocus = false; isSingleLine = true; setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f); styleInput(this); setOnFocusChangeListener { _, focused -> if (focused) activeField = this }; setOnClickListener { activeField = this } }
	private fun keyboardPalette(): KeyboardPalette {
		val dark = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return if (dark) KeyboardPalette(getColor(android.R.color.system_neutral1_900), getColor(android.R.color.system_neutral1_700), getColor(android.R.color.system_accent2_700), getColor(android.R.color.system_neutral1_50), getColor(android.R.color.system_neutral2_200), getColor(android.R.color.system_accent2_50)) else KeyboardPalette(getColor(android.R.color.system_neutral1_100), getColor(android.R.color.system_neutral1_10), getColor(android.R.color.system_accent2_100), getColor(android.R.color.system_neutral1_900), getColor(android.R.color.system_neutral2_700), getColor(android.R.color.system_accent2_900))
		return if (dark) KeyboardPalette(Color.rgb(40, 42, 46), Color.rgb(92, 94, 98), Color.rgb(66, 68, 72), Color.WHITE, Color.rgb(210, 214, 220), Color.WHITE) else KeyboardPalette(Color.rgb(232, 234, 238), Color.WHITE, Color.rgb(210, 214, 220), Color.rgb(38, 40, 42), Color.rgb(92, 94, 98), Color.rgb(38, 40, 42))
	}
	private fun key(label: String, special: Boolean = false, action: () -> Unit) = button(label, action).apply { background = rounded(if (special) palette.special else palette.key); gravity = Gravity.CENTER; setTextColor(if (special) palette.specialText else palette.text); setTextSize(TypedValue.COMPLEX_UNIT_SP, if (label == "⇧") 26f else if (special) 17f else 24f); typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL); setPadding(0, 0, 0, 0) }
	private fun keyParams(weight: Float = 1f) = LinearLayout.LayoutParams(0, dp(52), weight).apply { setMargins(dp(3), dp(3), dp(3), dp(3)) }
	private fun applySafeArea() {
		ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
			val bars = insets.getInsets(WindowInsetsCompat.Type.navigationBars() or WindowInsetsCompat.Type.mandatorySystemGestures())
			view.setPadding(0, 0, 0, bars.bottom + dp(22))
			insets
		}
		ViewCompat.requestApplyInsets(root)
	}
	private fun erase() { val field = activeField ?: search; val start = field.selectionStart.coerceAtLeast(0); if (start > 0) { val previous = Character.offsetByCodePoints(field.text, start, -1); field.text.delete(previous, start) } }
	private fun drawKeys() {
		keys.removeAllViews()
		val rows = if (numbers) listOf("1234567890", "@#%&*()-+=", ".,!?/:;_'\"") else listOf("qwertyuiop", "asdfghjkl", "zxcvbnm")
		for ((index, text) in rows.withIndex()) {
			val row = LinearLayout(this).apply { gravity = Gravity.CENTER }
			if (!numbers && index == 1) row.addView(View(this), LinearLayout.LayoutParams(0, 1, 0.5f))
			if (!numbers && index == 2) row.addView(key("⇧", true) { shifted = !shifted; drawKeys() }, keyParams(1.35f))
			for (character in text) { val label = if (shifted) character.uppercase() else character.toString(); row.addView(key(label) { type(label) }, keyParams()) }
			if (!numbers && index == 2) row.addView(key("⌫", true) { erase() }, keyParams(1.35f))
			if (!numbers && index == 1) row.addView(View(this), LinearLayout.LayoutParams(0, 1, 0.5f))
			keys.addView(row)
		}
		val controls = LinearLayout(this)
		val controlKeys = if (numbers) listOf<Pair<Pair<String, Float>, () -> Unit>>(Pair("ABC", 1.4f) to { numbers = false; drawKeys() }, Pair("Space", 4f) to { type(" ") }, Pair("Delete", 1.4f) to { erase() }, Pair("Return", 1.4f) to { type("\n") }) else listOf(Pair("?123", 1.4f) to { numbers = true; shifted = false; drawKeys() }, Pair(",", 1f) to { type(",") }, Pair("Space", 4f) to { type(" ") }, Pair(".", 1f) to { type(".") }, Pair("Return", 1.4f) to { type("\n") })
		for ((definition, action) in controlKeys) controls.addView(key(definition.first, true, action), keyParams(definition.second))
		keys.addView(controls)
	}
	private fun type(text: String) { val field = activeField ?: search; field.text.replace(field.selectionStart.coerceAtLeast(0), field.selectionEnd.coerceAtLeast(0), text) }
	private fun refresh() {
		try { snapshot = NativeCore.execute(this, JSONObject().put("action", "keyboard"), true).getJSONObject("data"); selected = null; values = JSONObject(); showTyping() }
		catch (error: Exception) { matches = emptyList(); matchCount = 0; candidateStrip.removeAllViews(); allButton.visibility = View.GONE; status.text = "Open TypeRelay and sync. ${error.message}"; showTyping(false) }
	}
	private fun findMatches(): Pair<List<SnippetMatch>, Int> {
		val found = mutableListOf<SnippetMatch>(); var count = 0; val query = search.text.toString(); val libraries = snapshot.optJSONArray("libraries") ?: JSONArray()
		for (libraryIndex in 0 until libraries.length()) {
			val library = libraries.getJSONObject(libraryIndex); val records = library.optJSONArray("records") ?: JSONArray()
			for (recordIndex in 0 until records.length()) {
				val record = records.getJSONObject(recordIndex); val content = record.optJSONObject("content") ?: JSONObject(); val title = record.optString("title").ifEmpty { record.optString("trigger").ifEmpty { "Untitled snippet" } }
				if (!(title + " " + record.optString("trigger") + " " + content.optString("text")).contains(query, ignoreCase = true)) continue
				count++; if (found.size < 60) found.add(SnippetMatch(record, library.optString("_id"), title))
			}
		}
		return found to count
	}
	private fun updateMatches() {
		search.visibility = if (search.text.isEmpty()) View.GONE else View.VISIBLE
		candidateStrip.removeAllViews()
		if (blocked) { matches = emptyList(); matchCount = 0; allButton.visibility = View.GONE; candidateScroll.visibility = View.GONE; status.text = "Switch keyboards to enter a password."; return }
		val result = findMatches(); matches = result.first; matchCount = result.second
		for (match in matches.take(3)) candidateStrip.addView(button(match.title) { select(match, KeyboardMode.TYPING) }, LinearLayout.LayoutParams(dp(132), dp(44)).apply { marginEnd = dp(4) })
		candidateScroll.visibility = if (matches.isEmpty()) View.GONE else View.VISIBLE
		allButton.visibility = if (matches.isEmpty()) View.GONE else View.VISIBLE
		allButton.text = "All"
		allButton.setOnClickListener { showResults() }
		status.text = if (matchCount == 0) "No snippets. Open TypeRelay to sync." else if (matchCount > 60) "Showing 60 of $matchCount. Refine search." else "$matchCount matches. Tap to preview or browse All."
	}
	private fun showTyping(update: Boolean = true) { mode = KeyboardMode.TYPING; selected = null; activeField = search; typingLayer.visibility = View.VISIBLE; overlayLayer.visibility = View.GONE; if (update) updateMatches() }
	private fun renderMode() { when (mode) { KeyboardMode.TYPING -> showTyping(); KeyboardMode.RESULTS -> showResults(); KeyboardMode.PREVIEW -> showPreview(); KeyboardMode.FIELD_EDITING -> editingField?.let { showFieldEditing(it.first, it.second, it.third) } ?: showPreview() } }
	private fun prepareOverlay(title: String, back: () -> Unit) {
		overlayLayer.removeAllViews()
		val header = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
		header.addView(button("← Back", back), LinearLayout.LayoutParams(dp(90), dp(46)))
		header.addView(TextView(this).apply { text = title; setTextColor(palette.text); setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f); maxLines = 1; gravity = Gravity.CENTER_VERTICAL }, LinearLayout.LayoutParams(0, dp(46), 1f))
		overlayLayer.addView(header)
		overlayBody = column(); overlayFooter = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
		typingLayer.visibility = View.GONE; overlayLayer.visibility = View.VISIBLE
	}
	private fun showResults() {
		if (blocked || matches.isEmpty()) return
		mode = KeyboardMode.RESULTS; selected = null; activeField = null
		prepareOverlay(if (search.text.isEmpty()) "All snippets" else search.text.toString()) { showTyping() }
		resultListScroll = ScrollView(this).apply { isFillViewport = true; addView(overlayBody) }
		for (match in matches) overlayBody.addView(button(match.title) { select(match, KeyboardMode.RESULTS) }, LinearLayout.LayoutParams(-1, dp(48)))
		overlayLayer.addView(resultListScroll, LinearLayout.LayoutParams(-1, 0, 1f))
		overlayFooter.addView(TextView(this).apply { text = if (matchCount > 60) "Showing 60 of $matchCount matches" else "$matchCount matches"; setTextColor(palette.muted); gravity = Gravity.CENTER_VERTICAL; setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f) }, LinearLayout.LayoutParams(0, dp(44), 1f))
		overlayLayer.addView(overlayFooter)
	}
	private fun select(match: SnippetMatch, returnMode: KeyboardMode) { selected = match.record; selectedLibrary = match.library; values = JSONObject(); previewReturnMode = returnMode; showPreview() }
	private fun render(preview: Boolean): JSONObject = NativeCore.execute(this, JSONObject().put("action", "keyboard_render").put("generation", snapshot.getString("generation")).put("library", selectedLibrary).put("id", selected!!.getString("id")).put("values", values).put("preview", preview), true).getJSONObject("data")
	private fun showPreview(message: String? = null, messageIsError: Boolean = true) {
		val record = selected ?: return showTyping()
		mode = KeyboardMode.PREVIEW; activeField = null
		val title = record.optString("title").ifEmpty { record.optString("trigger").ifEmpty { "Snippet preview" } }
		prepareOverlay(title) { if (previewReturnMode == KeyboardMode.RESULTS) showResults() else showTyping() }
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
		mode = KeyboardMode.FIELD_EDITING; editingField = Triple(name, label, multiline); typingLayer.visibility = View.VISIBLE; overlayLayer.visibility = View.GONE; search.visibility = View.GONE; candidateStrip.removeAllViews(); candidateScroll.visibility = View.VISIBLE
		val field = input(label).apply { isSingleLine = !multiline; setText(values.optString(name)); setSelection(text.length); addTextChangedListener(object: android.text.TextWatcher { override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}; override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { values.put(name, s.toString()) }; override fun afterTextChanged(s: android.text.Editable?) {} }) }
		candidateStrip.addView(TextView(this).apply { text = label; setTextColor(palette.text); gravity = Gravity.CENTER_VERTICAL; setPadding(dp(4), 0, dp(8), 0) }, LinearLayout.LayoutParams(-2, dp(44)))
		candidateStrip.addView(field, LinearLayout.LayoutParams(dp(220), dp(44))); activeField = field; field.requestFocus()
		allButton.visibility = View.VISIBLE; allButton.text = "Done"; allButton.setOnClickListener { showPreview() }; status.text = "Edit the field, then tap Done."
	}
	private fun insert(rich: Boolean) {
		try { val rendered = render(false); if (rendered.optInt("enter_actions") != 0 || blocked) return; val text = if (rich) Html.fromHtml(rendered.getString("html").replace(Regex("<img\\b[^>]*>", RegexOption.IGNORE_CASE), "[Image]"), Html.FROM_HTML_MODE_COMPACT) else rendered.getString("text"); if (currentInputConnection?.commitText(text, 1) != true) throw Exception("This field cannot accept the snippet. Copy it from TypeRelay instead."); selected = null; values = JSONObject(); showTyping() } catch (error: Exception) { showPreview(error.message ?: "The snippet could not be inserted.") }
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
			if (currentInputConnection?.commitContent(InputContentInfo(uri, ClipDescription("TypeRelay image", arrayOf(mime)), null), android.view.inputmethod.InputConnection.INPUT_CONTENT_GRANT_READ_URI_PERMISSION, null) != true) throw Exception("Image insertion was declined. Insert plain text instead.")
			showPreview("Image inserted.", false)
		} catch (error: Exception) { showPreview(error.message ?: "The image could not be inserted.") }
	}
}
