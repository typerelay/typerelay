package com.typerelay.mobile

import android.content.Context
import org.json.JSONObject
import java.io.File

object NativeCore {
    init { System.loadLibrary("typerelay_mobile") }
    @JvmStatic external fun call(directory: String, shared: String, request: String): String
    fun shared(context: Context) = File(context.noBackupFilesDir, "keyboard")
    @Synchronized fun execute(context: Context, request: JSONObject, keyboard: Boolean = false): JSONObject {
        val directory = if (keyboard) shared(context) else File(context.noBackupFilesDir, "typerelay")
        val response = JSONObject(call(directory.path, shared(context).path, request.toString()))
        if (response.has("error")) throw CoreException(response.getString("error"), response.optInt("status", 0))
        return response
    }
    class CoreException(message: String, val status: Int): Exception(message)
}
