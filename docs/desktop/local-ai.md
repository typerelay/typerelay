# On-device AI

Desktop and TUI share one local worker and one active model. AI is off until a model is explicitly downloaded and enabled. No web account or hosted AI provider is needed. The web app's AI is unchanged.

## Desktop

Open **Settings → Advanced → AI options** and check **Enable AI**. The **Choose local AI model** card appears with selectable model rows. Select a model, then choose **Download … GB Model** and confirm if it is not installed. Selecting an installed model activates it immediately. Interrupted downloads can resume; Cancel keeps downloaded bytes. Uncheck **Enable AI** to disable AI and hide the model card without deleting downloaded models. Switching models never downloads another model automatically.

Use the ordinary search input. Search starts as you type, showing Searching… until one combined result list is ready. There is no additional debounce delay or second AI result update. New input cancels superseded work; only the latest query waits to run. Exact abbreviation matches bypass AI. Descriptive queries retrieve and rank existing readable snippets from synced and local libraries. Results never contain generated snippets. Insert/copy rechecks access and revision.

## TUI

- In Settings, **Ctrl+G** opens model management. Arrow keys select a model; **d** downloads/resumes after confirmation, **e** enables an installed model, **x** disables AI, **r** removes it, and **c** cancels a download.
- In the editor, type a request in the body and click **Create** (or press **Ctrl+G**). Click **Rewrite** to improve existing text. Both replace the text directly in the same editor; Tab and Enter also reach these buttons.
- **Undo** or **Ctrl+Z** restores the previous text. **Esc** cancels generation without leaving the editor. Editing, saving or leaving cancels pending work; failures preserve your text. **Ctrl+S** saves normally. Existing template tokens, Enter actions, image references, metadata and content type remain unchanged.
- Global and per-library searches use the same combined search flow. Per-library search stays within the selected library. Disabled or unavailable AI falls back to ordinary matches.

## Storage and runtime

The existing Typerelay configuration directory contains `native-ai/settings.json`, verified `.gguf` models, resumable `.partial` files and private worker coordination files. Downloads use publisher/revision/filename/size/SHA-256 pins in `crates/client/src/ai-models.json`. Only downloads contact Hugging Face; inference has no HTTP client use. Search terms and drafts stay on the device.

`typerelay-ai` embeds `llama-cpp-2` and `llama-cpp-sys-2` 0.1.158. A per-user file lock prevents duplicate workers. Authenticated, length-bounded loopback IPC supports desktop and TUI across platforms. Inference never runs in the expansion process or UI event loop. Authoring is serialized; automatic search yields while authoring is queued/active. Cancellation checks run during model verification/loading, prompt batches and token generation. Model weights unload after five idle minutes; the next request reloads them. Updates stop the worker before replacing native executables.

CPU inference is supported on all native targets. Apple builds include Metal and retry model loading on CPU if GPU loading fails. Linux/Windows Vulkan builds use the `ai-vulkan` Cargo feature and require a Vulkan SDK at build time; standard portable staging uses CPU on those targets. Vulkan packaging and hardware validation remain release gates. Download sizes are exact; the UI deliberately does not claim minimum RAM until measurements are qualified across supported hardware.

## Validation and release gates

Backend tests cover exact-match bypass, disabled operation, candidate selection, immutable snippet validation, protected drafts, checksums, IPC ownership/authentication and pre-arrival cancellation. Frontend/TUI interaction tests are user-run.

The September 30, 2026 Apple M2 Pro smoke run passed routing and token-preserving drafting for all three models with external networking denied. Cold search / warm draft times were 5.43 / 1.19 seconds for Qwen 3.5 2B, 9.61 / 1.08 for Qwen 3.5 4B, and 11.23 / 0.84 for Gemma 4 E2B. [Recorded outputs and process memory observations](ai-benchmark-results.json) include the exact test results. CPU-only Qwen 3.5 2B passed at 10.84 / 1.87 seconds; its model unloaded after 302 idle seconds. Real download cancellation retained partial bytes; resuming verified SHA-256 and installed atomically.

On macOS, `scripts/tests/benchmark_native_ai.py --download` explicitly fetches isolated benchmark fixtures, verifies their pins, then blocks non-loopback networking using `sandbox-exec` during real inference. `--cpu` tests CPU; `--idle` verifies unloading after five minutes. This benchmark never changes the user's normal AI configuration. Reported process RSS is an observation, not a minimum RAM requirement or total GPU memory measurement.

Before public release, benchmark retrieval and drafting on representative Windows/Linux CPU and Vulkan hardware and Intel/Apple Silicon Macs; build and test each native installer. A passing two-prompt smoke test is not a quality evaluation. Older standalone Linux updaters only accept three-file archives: migrate those installations to a current native package before publishing a four-file legacy AI bundle. No automatic public release is part of this change.

See [AI third-party notices](ai-notices.txt) for runtime and model licenses.
