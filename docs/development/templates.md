# Template implementation

The pure parser/renderer is `crates/core/src/template.rs`; the thin `crates/template-wasm` crate exports its owned-buffer ABI. Keep the core an rlib: mixing a core cdylib with separate desktop/workspace feature graphs can overwrite un-hashed build outputs in a shared Cargo target directory.

Content remains envelope version 1 with `type: template`, source text and variable definitions. Unknown non-reserved identifiers are text fields. Date/time/timestamp and key:enter are reserved. Rendering is one pass: answers and defaults are never parsed as source. The template renderer receives one timestamp and local UTC offset, so evaluation has no IO.

Sync protocol 6 prevents old desktops exchanging rich-text records or assets they cannot retain. Public API routes stay v3. Existing Text/Code remain literal. Browser runtime answers only go to the local WASM module; native answers only go to the local Rust runtime and private IPC. No runtime answers are persisted or synchronized.

Omarchy snapshots retain stable identity/revision and a precomputed prompt flag. Immediate templates render on a worker while following typing is buffered through the existing insertion path. Prompted matches send a PID-validated notification before any erasure. The panel requests preparation using the original event deadline and input generation; only then does it open the fill form. Completion sends a fresh request after confirmation.

Private notifications remain datagrams; insertion uses a bounded Unix stream so long values cannot exceed a datagram limit. The service revalidates identity/access before each ordered text/Enter step. Acknowledgments carry input/context generation, preventing later steps after interruption. No completed Enter action is retried. Clipboard ownership/restoration uses the existing paste implementation.

Tests: core parser/clock/literal handling, SQLite metadata/snapshot identity, TUI dialogs, server import/move/conflict/Trash preservation, two offline clients, protocol rejection, real browser WASM/editor/fill/copy, and native panel controls. `scripts/template-smoke.py --live` requires explicit idle authorization, uses temporary data and disposable windows, and restores the original service/panel/focus.
