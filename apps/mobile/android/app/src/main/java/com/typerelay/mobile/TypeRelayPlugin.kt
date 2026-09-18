package com.typerelay.mobile

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.provider.Settings
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

@CapacitorPlugin(name = "TypeRelay")
class TypeRelayPlugin: Plugin() {
    private val executor = Executors.newSingleThreadExecutor()
    @PluginMethod fun execute(call: PluginCall) {
        val request = call.getString("request") ?: return call.reject("Missing request")
        executor.execute {
            try {
                val parsed = JSONObject(request)
                val response = NativeCore.execute(context, parsed)
                if (parsed.optString("action") == "reset") File(context.cacheDir, "keyboard").deleteRecursively()
                call.resolve(JSObject(response.toString()))
            } catch (error: Exception) { call.reject(error.message ?: "Native operation failed", ((error as? NativeCore.CoreException)?.status ?: 0).toString(), error) }
        }
    }
    @PluginMethod fun copy(call: PluginCall) {
        val text = call.getString("text") ?: ""
        val html = call.getString("html")
        val clip = if (html == null) ClipData.newPlainText("TypeRelay", text) else ClipData.newHtmlText("TypeRelay", text, html)
        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(clip)
        call.resolve()
    }
    override fun handleOnDestroy() { executor.shutdown() }
    @PluginMethod fun keyboardSettings(call: PluginCall) { context.startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); call.resolve() }
}
