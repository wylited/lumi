//! Blocking, the only place the app changes the machine. Everything here is reversible:
//!
//! - an app is **hidden** (`NSRunningApplication -hide`), never quit — nothing is lost, and undo
//!   is `-unhide` plus bringing it back to the front;
//! - a browser tab is **sent to a local page** that says why, through the browser's own AppleScript
//!   dictionary. The URL it was on is returned first, so undo is navigating back to it.
//!
//! AppleScript asks macOS for Automation permission once per browser (`NSAppleEventsUsageDescription`
//! in `Info.plist`). Firefox has no tab dictionary and is not supported; the webview says so.
//! Commands run off the main thread: the first `osascript` call can wait on that consent dialog.

use std::ffi::{c_void, CString};
use std::process::Command;

use tauri::{AppHandle, Manager};

use crate::signals::apps::{
    is_browser, objc_autoreleasePoolPop, objc_autoreleasePoolPush, objc_getClass, objc_msgSend, sel,
    Id,
};

const NS_APPLICATION_ACTIVATE_IGNORING_OTHER_APPS: u64 = 1 << 1;

/// The running app behind `pid`, or null.
unsafe fn running_app(pid: i32) -> Id {
    let class = CString::new("NSRunningApplication").unwrap_or_default();
    let f: extern "C" fn(Id, Id, i32) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
    f(
        objc_getClass(class.as_ptr()),
        sel("runningApplicationWithProcessIdentifier:"),
        pid,
    )
}

unsafe fn send_bool(obj: Id, name: &str) -> bool {
    let f: extern "C" fn(Id, Id) -> bool = std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, sel(name))
}

/// Hide the app with this pid. False only when there is no such app.
///
/// `-hide` answers NO for an app that is frontmost at the moment of asking, and hides it anyway
/// (checked by hand against TextEdit), so its return value is not the answer.
#[tauri::command]
pub fn hide_app(pid: i32) -> bool {
    unsafe {
        let pool = objc_autoreleasePoolPush();
        let app = running_app(pid);
        if !app.is_null() {
            send_bool(app, "hide");
        }
        objc_autoreleasePoolPop(pool);
        !app.is_null()
    }
}

/// Undo `hide_app`: show it again and bring it to the front.
#[tauri::command]
pub fn unhide_app(pid: i32) -> bool {
    unsafe {
        let pool = objc_autoreleasePoolPush();
        let app = running_app(pid);
        let ok = !app.is_null() && send_bool(app, "unhide");
        if !app.is_null() {
            let f: extern "C" fn(Id, Id, u64) -> bool =
                std::mem::transmute(objc_msgSend as *const c_void);
            f(
                app,
                sel("activateWithOptions:"),
                NS_APPLICATION_ACTIVATE_IGNORING_OTHER_APPS,
            );
        }
        objc_autoreleasePoolPop(pool);
        ok
    }
}

/// Safari calls it `current tab`; every Chromium browser with a dictionary calls it `active tab`.
fn tab_of(bundle_id: &str) -> Option<&'static str> {
    match bundle_id {
        "com.apple.Safari" => Some("current tab of front window"),
        "org.mozilla.firefox" => None,
        id if is_browser(id) => Some("active tab of front window"),
        _ => None,
    }
}

fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn osascript(script: &str) -> Result<String, String> {
    let out = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// The URL of the front tab of this browser. Errs with the reason (no permission, no window,
/// a browser without a tab dictionary) so the webview can say it.
#[tauri::command]
pub async fn browser_url(bundle_id: String) -> Result<String, String> {
    let tab = tab_of(&bundle_id).ok_or("unsupported_browser")?;
    let script = format!(
        "tell application id {} to return URL of {tab}",
        quoted(&bundle_id)
    );
    tauri::async_runtime::spawn_blocking(move || osascript(&script))
        .await
        .map_err(|e| e.to_string())?
}

/// Point the front tab of this browser at `url`.
#[tauri::command]
pub async fn browser_navigate(bundle_id: String, url: String) -> Result<(), String> {
    let tab = tab_of(&bundle_id).ok_or("unsupported_browser")?;
    let script = format!(
        "tell application id {} to set URL of {tab} to {}",
        quoted(&bundle_id),
        quoted(&url)
    );
    tauri::async_runtime::spawn_blocking(move || osascript(&script).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}

const BLOCKED_PAGE: &str = include_str!("blocked.html");

/// The local page a blocked tab is sent to, as a `file://` URL carrying the site and the goal.
#[tauri::command]
pub fn blocked_page(app: AppHandle, site: String, goal: String) -> Result<String, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("blocked.html");
    std::fs::write(&path, BLOCKED_PAGE).map_err(|e| e.to_string())?;
    let enc = |s: &str| -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (b as char).to_string()
                }
                _ => format!("%{b:02X}"),
            })
            .collect()
    };
    Ok(format!(
        "file://{}?site={}&goal={}",
        path.to_string_lossy(),
        enc(&site),
        enc(&goal)
    ))
}

#[cfg(test)]
mod tests {
    use super::{quoted, tab_of};

    #[test]
    fn quotes_cannot_break_out_of_the_script() {
        assert_eq!(quoted(r#"a"b\c"#), r#""a\"b\\c""#);
    }

    #[test]
    fn safari_and_chromium_name_their_tab_differently() {
        assert_eq!(tab_of("com.apple.Safari"), Some("current tab of front window"));
        assert_eq!(tab_of("com.google.Chrome"), Some("active tab of front window"));
        assert_eq!(tab_of("org.mozilla.firefox"), None);
        assert_eq!(tab_of("com.apple.TextEdit"), None);
    }
}
