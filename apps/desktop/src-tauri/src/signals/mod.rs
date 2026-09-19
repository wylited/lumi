//! Native signals. `HELI-033` fills this module: the sampling loop, the permission probes and the
//! per-signal submodules. The shell only fixes its surface — `install`, `permissions` and
//! `open_settings_pane` — so the command list in `main.rs` never has to change.

use tauri::AppHandle;

pub fn install(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}

#[tauri::command]
pub fn permissions() -> Vec<serde_json::Value> {
    Vec::new()
}

#[tauri::command]
pub fn open_settings_pane(_pane: String) -> Result<(), String> {
    Ok(())
}
