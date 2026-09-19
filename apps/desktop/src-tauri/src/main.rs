// Prevents an extra console window on Windows in release. Harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod signals;
mod tray;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// ⌃⌥H from anywhere brings the window back.
fn raise_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyH)
}

pub fn raise(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if *shortcut == raise_shortcut() && event.state() == ShortcutState::Pressed {
                        raise(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            tray::install(app.handle())?;
            if let Err(error) = app.global_shortcut().register(raise_shortcut()) {
                // Another app owns the chord. The tray still raises the window.
                eprintln!("helicopter: global shortcut unavailable: {error}");
            }
            signals::install(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing hides: the observer keeps running in the menu bar. Quit lives in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        // The command surface. Signal modules register here through `signals`, never by
        // rewriting this list.
        .invoke_handler(tauri::generate_handler![
            tray::set_tray_state,
            signals::permissions,
            signals::open_settings_pane,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the Helicopter app");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let RunEvent::Reopen { .. } = event {
            raise(app);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}
