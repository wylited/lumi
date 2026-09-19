//! A periodic screen frame, as rarely as it can be.
//!
//! At most one frame every 10 s, and only when the frontmost app changed or the screen changed
//! beyond a threshold since the last frame kept. Frames are downscaled to 1280 px on the long edge
//! and JPEG q80 before they leave the process. Capture goes through the system `screencapture`
//! (ScreenCaptureKit underneath on current macOS), so it is bound by the same Screen Recording
//! consent: with it missing, nothing is captured and nothing is logged.
//!
//! Apps on the deny list — password managers, banking — are never captured. The user edits the
//! list in Settings.

use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::ipc::Response;
use tauri::AppHandle;

use super::{apps, emit, permissions, Signal};

const MIN_GAP: Duration = Duration::from_secs(10);
/// Mean absolute difference, 0–255, on a 16×16 grey thumbnail.
const CHANGE_THRESHOLD: f32 = 6.0;

static DENY: Mutex<Vec<String>> = Mutex::new(Vec::new());
static LATEST: Mutex<Option<(String, Vec<u8>)>> = Mutex::new(None);

const DEFAULT_DENY: [&str; 9] = [
    "com.1password.1password",
    "com.agilebits.onepassword7",
    "com.bitwarden.desktop",
    "com.lastpass.LastPass",
    "com.dashlane.dashlanephonefinal",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.revolut.macos",
    "com.paypal.PayPal",
];

pub fn spawn(app: AppHandle) {
    if let Ok(mut deny) = DENY.lock() {
        if deny.is_empty() {
            *deny = DEFAULT_DENY.iter().map(|s| s.to_string()).collect();
        }
    }
    thread::Builder::new()
        .name("heli-screen".into())
        .spawn(move || run(app))
        .expect("spawn the screen sampler");
}

fn run(app: AppHandle) {
    let dir = std::env::temp_dir().join("heli-screen");
    let _ = std::fs::create_dir_all(&dir);
    let mut last_kept: Option<Instant> = None;
    let mut last_app = String::new();
    let mut last_thumb: Option<Vec<u8>> = None;
    let mut n: u64 = 0;

    loop {
        thread::sleep(Duration::from_secs(2));
        if !permissions::screen_recording() {
            continue;
        }
        if last_kept.is_some_and(|t| t.elapsed() < MIN_GAP) {
            continue;
        }
        let front = apps::CURRENT
            .lock()
            .ok()
            .and_then(|c| c.clone())
            .unwrap_or_default();
        if denied(&front.bundle_id) {
            continue;
        }

        let raw = dir.join("raw.jpg");
        let thumb_path = dir.join("thumb.bmp");
        if !capture(&raw) || !thumbnail(&raw, &thumb_path) {
            continue;
        }
        let thumb = std::fs::read(&thumb_path).ok().and_then(|b| grey(&b));
        let app_changed = front.bundle_id != last_app;
        let content_changed = match (&thumb, &last_thumb) {
            (Some(a), Some(b)) => difference(a, b) > CHANGE_THRESHOLD,
            _ => true,
        };
        if !app_changed && !content_changed {
            continue;
        }

        let out = dir.join("frame.jpg");
        if !downscale(&raw, &out) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&out) else {
            continue;
        };
        let _ = std::fs::remove_file(&raw);
        n += 1;
        let frame_ref = format!("screen_{}_{n}", std::process::id());
        emit(
            &app,
            Signal::new("screen", "screen.frame", 1.0)
                .with("ref", frame_ref.clone())
                .with("bytes", bytes.len())
                .with("app", front.name.clone())
                .with(
                    "reason",
                    if app_changed {
                        "app_changed"
                    } else {
                        "content_changed"
                    },
                ),
        );
        if let Ok(mut latest) = LATEST.lock() {
            *latest = Some((frame_ref, bytes));
        }
        last_kept = Some(Instant::now());
        last_app = front.bundle_id;
        last_thumb = thumb;
    }
}

/// The lock screen is never captured, whatever the list says.
const NEVER: [&str; 2] = ["com.apple.loginwindow", "com.apple.ScreenSaver.Engine"];

fn denied(bundle_id: &str) -> bool {
    if bundle_id.is_empty() || NEVER.contains(&bundle_id) {
        return true;
    }
    DENY.lock()
        .map(|d| d.iter().any(|x| x.eq_ignore_ascii_case(bundle_id)))
        .unwrap_or(true)
}

fn capture(to: &PathBuf) -> bool {
    Command::new("/usr/sbin/screencapture")
        .args(["-x", "-m", "-t", "jpg"])
        .arg(to)
        .status()
        .is_ok_and(|s| s.success())
}

fn thumbnail(from: &PathBuf, to: &PathBuf) -> bool {
    Command::new("/usr/bin/sips")
        .args(["-s", "format", "bmp", "-z", "16", "16"])
        .arg(from)
        .arg("--out")
        .arg(to)
        .output()
        .is_ok_and(|o| o.status.success())
}

fn downscale(from: &PathBuf, to: &PathBuf) -> bool {
    Command::new("/usr/bin/sips")
        .args([
            "-Z",
            "1280",
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            "80",
        ])
        .arg(from)
        .arg("--out")
        .arg(to)
        .output()
        .is_ok_and(|o| o.status.success())
}

/// A 16×16 BMP (24 or 32 bpp) → 256 grey values.
fn grey(bmp: &[u8]) -> Option<Vec<u8>> {
    if bmp.len() < 54 || &bmp[0..2] != b"BM" {
        return None;
    }
    let offset = u32::from_le_bytes(bmp[10..14].try_into().ok()?) as usize;
    let bpp = u16::from_le_bytes(bmp[28..30].try_into().ok()?) as usize / 8;
    if bpp < 3 {
        return None;
    }
    let row = (16 * bpp + 3) & !3;
    let mut out = Vec::with_capacity(256);
    for y in 0..16 {
        for x in 0..16 {
            let i = offset + y * row + x * bpp;
            let px = bmp.get(i..i + 3)?;
            out.push(((px[0] as u32 * 29 + px[1] as u32 * 150 + px[2] as u32 * 77) >> 8) as u8);
        }
    }
    Some(out)
}

fn difference(a: &[u8], b: &[u8]) -> f32 {
    let sum: u32 = a.iter().zip(b).map(|(x, y)| x.abs_diff(*y) as u32).sum();
    sum as f32 / a.len().max(1) as f32
}

#[tauri::command]
pub fn set_screen_denylist(bundle_ids: Vec<String>) {
    if let Ok(mut deny) = DENY.lock() {
        *deny = bundle_ids
            .into_iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
    }
}

#[tauri::command]
pub fn screen_denylist() -> Vec<String> {
    DENY.lock().map(|d| d.clone()).unwrap_or_default()
}

/// The last frame kept, as raw JPEG bytes, for the webview to upload.
#[tauri::command]
pub fn latest_screen_frame() -> Response {
    let bytes = LATEST
        .lock()
        .ok()
        .and_then(|l| l.as_ref().map(|(_, b)| b.clone()))
        .unwrap_or_default();
    Response::new(bytes)
}

#[cfg(test)]
mod tests {
    use super::{denied, difference, DENY};

    #[test]
    fn difference_is_mean_absolute() {
        assert_eq!(difference(&[0, 10, 20], &[0, 10, 20]), 0.0);
        assert_eq!(difference(&[0, 0], &[10, 30]), 20.0);
    }

    #[test]
    fn the_deny_list_is_case_insensitive() {
        *DENY.lock().unwrap() = vec!["com.1password.1password".into()];
        assert!(denied("com.1Password.1password"));
        assert!(!denied("com.microsoft.VSCode"));
        assert!(
            denied("com.apple.loginwindow"),
            "the lock screen is never captured"
        );
    }
}
