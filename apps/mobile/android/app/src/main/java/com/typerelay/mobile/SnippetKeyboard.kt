package com.typerelay.mobile

import android.content.ClipDescription
import android.content.Context
import android.inputmethodservice.InputMethodService
import android.os.Build
import android.text.Html
import android.text.InputType
import android.util.Base64
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputContentInfo
import android.view.inputmethod.InputMethodManager
import android.widget.*
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class SnippetKeyboard: InputMethodService() {
    private lateinit var root: LinearLayout
    private lateinit var results: LinearLayout
    private lateinit var search: EditText
    private lateinit var status: TextView
    private lateinit var keys: LinearLayout
    private var snapshot = JSONObject()
    private var selected: JSONObject? = null
    private var selectedLibrary = ""
    private var library = ""
    private var values = JSONObject()
    private var activeField: EditText? = null
    private var shifted = false
    private var numbers = false
    private var blocked = false
    override fun onCreateInputView(): View {
        root = column()
        val toolbar = LinearLayout(this)
        toolbar.addView(button("Next keyboard") { (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showInputMethodPicker() })
        toolbar.addView(button("Libraries") { libraries() })
        toolbar.addView(button("Back") { refresh() })
        root.addView(toolbar)
        root.addView(TextView(this).apply { text = "Search snippets" }); search = input("Search snippets"); search.addTextChangedListener(object: android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { if (::results.isInitialized && selected == null) list() }
            override fun afterTextChanged(s: android.text.Editable?) {}
        }); root.addView(search)
        val scroll = ScrollView(this); results = column(); scroll.addView(results); root.addView(scroll, LinearLayout.LayoutParams(-1, dp(140)))
        status = TextView(this); root.addView(status)
        keys = column(); root.addView(keys); drawKeys()
        return root
    }
    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        val variation = (info?.inputType ?: 0) and InputType.TYPE_MASK_VARIATION
        val type = (info?.inputType ?: 0) and InputType.TYPE_MASK_CLASS
        blocked = (type == InputType.TYPE_CLASS_TEXT && variation in listOf(InputType.TYPE_TEXT_VARIATION_PASSWORD, InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD, InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD)) || (type == InputType.TYPE_CLASS_NUMBER && variation == InputType.TYPE_NUMBER_VARIATION_PASSWORD)
        refresh()
    }
    override fun onFinishInputView(finishingInput: Boolean) { super.onFinishInputView(finishingInput); values = JSONObject(); selected = null; snapshot = JSONObject(); activeField = null; if (::results.isInitialized) results.removeAllViews() }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun column() = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(4), dp(2), dp(4), dp(2)) }
    private fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; isAllCaps = false; minWidth = 0; minimumWidth = 0; setPadding(dp(3), 0, dp(3), 0); setOnClickListener { action() } }
    private fun input(label: String) = EditText(this).apply { contentDescription = label; showSoftInputOnFocus = false; isSingleLine = true; setOnFocusChangeListener { _, focused -> if (focused) activeField = this }; setOnClickListener { activeField = this } }
    private fun drawKeys() {
        keys.removeAllViews()
        val rows = if (numbers) listOf("1234567890", "@#%&*()-+=", ".,!?/:;_'\"") else listOf("qwertyuiop", "asdfghjkl", "zxcvbnm")
        for (text in rows) { val row = LinearLayout(this); for (character in text) { val key = if (shifted) character.uppercase() else character.toString(); row.addView(button(key) { type(key) }, LinearLayout.LayoutParams(0, dp(38), 1f)) }; keys.addView(row) }
        val controls = LinearLayout(this)
        for ((label, action) in listOf<Pair<String, () -> Unit>>("Shift" to { shifted = !shifted; drawKeys() }, "123" to { numbers = !numbers; drawKeys() }, "Space" to { type(" ") }, "Delete" to { val field = activeField ?: search; val start = field.selectionStart.coerceAtLeast(0); if (start > 0) { val previous = Character.offsetByCodePoints(field.text, start, -1); field.text.delete(previous, start) } }, "Return" to { type("\n") })) controls.addView(button(label, action), LinearLayout.LayoutParams(0, dp(38), 1f))
        keys.addView(controls)
    }
    private fun type(text: String) { val field = activeField ?: search; field.text.replace(field.selectionStart.coerceAtLeast(0), field.selectionEnd.coerceAtLeast(0), text) }
    private fun refresh() { try { snapshot = NativeCore.execute(this, JSONObject().put("action", "keyboard"), true).getJSONObject("data"); selected = null; list() } catch (error: Exception) { status.text = "Open TypeRelay and sync. ${error.message}"; results.removeAllViews() } }
    private fun libraries() { selected = null; results.removeAllViews(); results.addView(button("All libraries") { library = ""; list() }); val items = snapshot.optJSONArray("libraries") ?: JSONArray(); for (index in 0 until items.length()) { val item = items.getJSONObject(index); results.addView(button(item.getString("name")) { library = item.getString("_id"); list() }) } }
    private fun list() {
        results.removeAllViews(); activeField = search
        if (blocked) { status.text = "Switch keyboards to enter a password."; return }
        val items = snapshot.optJSONArray("libraries") ?: JSONArray(); var count = 0
        for (index in 0 until items.length()) {
            val item = items.getJSONObject(index); if (library.isNotEmpty() && item.getString("_id") != library) continue
            val records = item.optJSONArray("records") ?: JSONArray()
            for (recordIndex in 0 until records.length()) {
                val record = records.getJSONObject(recordIndex); val content = record.getJSONObject("content"); val title = record.optString("title").ifEmpty { record.optString("trigger").ifEmpty { "Untitled snippet" } }
                if (!(title + " " + record.optString("trigger") + " " + content.optString("text")).contains(search.text.toString(), ignoreCase = true)) continue
                count++; if (count > 60) continue
                results.addView(button(title) { selected = record; selectedLibrary = item.getString("_id"); values = JSONObject(); showSelection() })
            }
        }
        status.text = if (count == 0) "No snippets. Open TypeRelay to sync." else if (count > 60) "Showing 60 matches. Refine your search." else "Tap a snippet to preview."
    }
    private fun render(preview: Boolean): JSONObject {
        return NativeCore.execute(this, JSONObject().put("action", "keyboard_render").put("generation", snapshot.getString("generation")).put("library", selectedLibrary).put("id", selected!!.getString("id")).put("values", values).put("preview", preview), true).getJSONObject("data")
    }
    private fun showSelection() {
        results.removeAllViews()
        try {
            val rendered = render(true); val definitions = rendered.optJSONObject("variables") ?: rendered.optJSONObject("template")?.optJSONObject("variables") ?: JSONObject()
            val fields = rendered.optJSONArray("fields") ?: JSONArray()
            for (index in 0 until fields.length()) { val name = fields.getString(index); val definition = definitions.optJSONObject(name) ?: JSONObject(); val label = definition.optString("label").ifEmpty { name }; results.addView(TextView(this).apply { text = label }); val field = input(label); field.isSingleLine = !definition.optBoolean("multiline"); field.setText(values.optString(name, definition.optString("default"))); values.put(name, field.text.toString()); field.addTextChangedListener(object: android.text.TextWatcher { override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {} override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { values.put(name, s.toString()) } override fun afterTextChanged(s: android.text.Editable?) {} }); results.addView(field); if (index == 0) { field.requestFocus(); activeField = field } }
            results.addView(TextView(this).apply { text = rendered.optString("text"); maxLines = 4 })
            val supported = rendered.optInt("enter_actions") == 0
            results.addView(button("Insert plain text") { insert(false) }.apply { isEnabled = supported })
            if (rendered.has("html")) results.addView(button("Insert formatted text (app dependent)") { insert(true) }.apply { isEnabled = supported })
            val assets = rendered.optJSONArray("assets") ?: JSONArray()
            for (index in 0 until assets.length()) { val id = assets.getString(index); results.addView(button("Insert image ${index + 1}") { insertImage(id) }.apply { isEnabled = supported }) }
            status.text = if (supported) "Formatting and images depend on the destination app." else "Desktop Enter actions cannot run on mobile."
        } catch (error: Exception) { status.text = error.message }
    }
    private fun insert(rich: Boolean) {
        try { val rendered = render(false); if (rendered.optInt("enter_actions") != 0 || blocked) return; val text = if (rich) Html.fromHtml(rendered.getString("html").replace(Regex("<img\\b[^>]*>", RegexOption.IGNORE_CASE), "[Image]"), Html.FROM_HTML_MODE_COMPACT) else rendered.getString("text"); if (currentInputConnection?.commitText(text, 1) != true) throw Exception("This field cannot accept the snippet. Copy it from TypeRelay instead."); selected = null; values = JSONObject(); list() } catch (error: Exception) { status.text = error.message }
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
            status.text = "Image inserted."
        } catch (error: Exception) { status.text = error.message }
    }
}
