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
}
