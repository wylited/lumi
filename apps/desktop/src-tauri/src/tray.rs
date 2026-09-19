//! The menu-bar item. It is the ambient tier: its colour is the state, and it never nags.
//!
//! The icon is drawn here, at runtime, in whatever colour the webview passes — the webview reads
//! it from `@heli/tokens`, so the palette still has exactly one source.

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

const TRAY_ID: &str = "heli";
/// 18 pt at 2x.
const SIZE: u32 = 36;

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Glyph {
    /// Hollow ring: nothing is being watched.
    Ring,
    /// Solid dot: watching.
    Dot,
    /// Dot with a halo: speaking.
    Halo,
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Idle", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Helicopter", true, Some("Ctrl+Alt+H"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit Helicopter", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(
        app,
        &[&status, &PredefinedMenuItem::separator(app)?, &open, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    app.manage(StatusItem(status));

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(draw(Glyph::Ring, [148, 165, 158]))
        .icon_as_template(false)
        .tooltip("Helicopter · idle")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => crate::raise(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

struct StatusItem(MenuItem<Wry>);

/// Called by the webview whenever the live state changes.
#[tauri::command]
pub fn set_tray_state(app: AppHandle, label: String, glyph: Glyph, rgb: [u8; 3]) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("tray not installed")?;
    tray.set_icon(Some(draw(glyph, rgb))).map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(format!("Helicopter · {label}"))).map_err(|e| e.to_string())?;
    if let Some(item) = app.try_state::<StatusItem>() {
        let mut text = label;
        if let Some(first) = text.get_mut(0..1) {
            first.make_ascii_uppercase();
        }
        item.0.set_text(text).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Anti-aliased by coverage: each pixel takes the fraction of the shape its centre is inside.
fn draw(glyph: Glyph, [r, g, b]: [u8; 3]) -> Image<'static> {
    let c = SIZE as f32 / 2.0;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let d = ((x as f32 + 0.5 - c).powi(2) + (y as f32 + 0.5 - c).powi(2)).sqrt();
            let fill = |radius: f32| (radius + 0.5 - d).clamp(0.0, 1.0);
            let ring = |radius: f32, width: f32| (width / 2.0 + 0.5 - (d - radius).abs()).clamp(0.0, 1.0);
            let a = match glyph {
                Glyph::Ring => ring(7.0, 2.5),
                Glyph::Dot => fill(8.0),
                Glyph::Halo => fill(7.0).max(ring(13.0, 2.0) * 0.55),
            };
            let i = ((y * SIZE + x) * 4) as usize;
            rgba[i] = r;
            rgba[i + 1] = g;
            rgba[i + 2] = b;
            rgba[i + 3] = (a * 255.0).round() as u8;
        }
    }
    Image::new_owned(rgba, SIZE, SIZE)
}
