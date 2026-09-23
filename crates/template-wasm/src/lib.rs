#[cfg(target_arch = "wasm32")]
pub struct WasmTemplate;
// Small owned-buffer ABI for the browser. No native clock, filesystem or callbacks.
#[cfg(target_arch = "wasm32")]
impl WasmTemplate {
    #[unsafe(no_mangle)]
    pub extern "C" fn template_alloc(len: usize) -> *mut u8 { let buffer = vec![0u8; len].into_boxed_slice(); Box::into_raw(buffer).cast::<u8>() }
    /// # Safety
    /// The pointer and length must identify a live buffer returned by this module.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn template_free(ptr: *mut u8, len: usize) { unsafe { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len))); } }
    /// # Safety
    /// The input must be an initialized buffer allocated in this module memory.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn template_render(ptr: *const u8, len: usize) -> u64 {
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
        let output = typerelay_core::template::Template::json(std::str::from_utf8(bytes).unwrap_or(""));
        let length = output.len(); let buffer = output.into_bytes().into_boxed_slice();
        let address = Box::into_raw(buffer).cast::<u8>() as u32;
        ((address as u64) << 32) | length as u64
    }
    /// # Safety
    /// The input must be an initialized buffer allocated in this module memory.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn rich_text_render(ptr: *const u8, len: usize) -> u64 {
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
        let output = typerelay_core::rich_text::RichText::json(std::str::from_utf8(bytes).unwrap_or(""));
        let length = output.len(); let buffer = output.into_bytes().into_boxed_slice();
        let address = Box::into_raw(buffer).cast::<u8>() as u32;
        ((address as u64) << 32) | length as u64
    }
	/// # Safety
	/// The input must be an initialized buffer allocated in this module memory.
	#[unsafe(no_mangle)]
	pub unsafe extern "C" fn abbreviation_match(ptr: *const u8, len: usize) -> u64 {
		use typerelay_core::{Engine, Input, Snapshot, Snippet};
		let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
		let result = (|| -> Result<serde_json::Value, String> {
			#[derive(serde::Deserialize)] struct Request { before: String, prefix: String, triggers: Vec<String> }
			let request: Request = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
			let snippets = request.triggers.into_iter().map(|trigger| Snippet { trigger, replacement: "x".into() }).collect();
			let mut engine = Engine::new(Snapshot::new(snippets)?);
			engine.set_prefix(&request.prefix)?;
			for character in request.before.chars() { engine.feed(Input::Character(character)); }
			Ok(match engine.feed(Input::Space) { Some(expansion) => serde_json::json!({"trigger": request.before.chars().rev().take(expansion.erase - 1).collect::<String>().chars().rev().collect::<String>(), "erase": expansion.erase}), None => serde_json::Value::Null })
		})();
		let output = result.unwrap_or_else(|error| serde_json::json!({"error": error})).to_string();
		let length = output.len(); let buffer = output.into_bytes().into_boxed_slice();
		let address = Box::into_raw(buffer).cast::<u8>() as u32;
		((address as u64) << 32) | length as u64
	}
}
