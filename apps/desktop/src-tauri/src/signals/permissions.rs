//! The real state of each macOS consent, and the exact pane to grant it in.

use serde::Serialize;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}

#[link(name = "IOKit", kind = "framework")]
extern "C" {
    fn IOHIDCheckAccess(request: u32) -> u32;
}

const HID_LISTEN_EVENT: u32 = 1;
const HID_GRANTED: u32 = 0;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Permission {
    pub id: &'static str,
    pub label: &'static str,
    /// `granted`, `missing`, or `unavailable` when macOS gives third-party apps no way to read it.
    pub state: &'static str,
    pub used_for: &'static str,
    pub pane: Option<&'static str>,
}

pub fn screen_recording() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

/**
 * Input Monitoring is the CoreGraphics listen-event grant. Asking through IOKit
 * (`IOHIDRequestAccess`) does not register the app with TCC, so it never appears
 * in the pane and the grant was unreachable; `CGRequestListenEventAccess` is the
 * call that both prompts and lists it.
 */
pub fn input_monitoring() -> bool {
    let cg = unsafe { CGPreflightListenEventAccess() };
    // The IOKit answer is kept as a fallback for the tap's own view of the grant.
    cg || unsafe { IOHIDCheckAccess(HID_LISTEN_EVENT) == HID_GRANTED }
}

pub fn accessibility() -> bool {
    unsafe { AXIsProcessTrusted() }
}

fn state(ok: bool) -> &'static str {
    if ok {
        "granted"
    } else {
        "missing"
    }
}

#[tauri::command]
pub fn permissions() -> Vec<Permission> {
    vec![
        Permission {
            id: "accessibility",
            label: "Accessibility",
            state: state(accessibility()),
            used_for:
                "Which part of the front app has focus — its role and label, never its contents.",
            pane: Some("Privacy_Accessibility"),
        },
        Permission {
            id: "screen",
            label: "Screen Recording",
            state: state(screen_recording()),
            used_for: "Window titles, and a small screen frame at most every 10 s.",
            pane: Some("Privacy_ScreenCapture"),
        },
        Permission {
            id: "input",
            label: "Input Monitoring",
            state: state(input_monitoring()),
            used_for: "How often you type and click. Never which keys.",
            pane: Some("Privacy_ListenEvent"),
        },
    ]
}

/// Asks macOS to show its own prompt where one exists. The answer arrives later, in Settings.
#[tauri::command]
pub fn request_permission(id: String) -> bool {
    match id.as_str() {
        "screen" => unsafe { CGRequestScreenCaptureAccess() },
        "input" => unsafe { CGRequestListenEventAccess() },
        _ => false,
    }
}

const PANES: [&str; 3] = [
    "Privacy_Accessibility",
    "Privacy_ScreenCapture",
    "Privacy_ListenEvent",
];

#[tauri::command]
pub fn open_settings_pane(pane: String) -> Result<(), String> {
    if !PANES.contains(&pane.as_str()) {
        return Err(format!("unknown pane {pane}"));
    }
    std::process::Command::new("open")
        .arg(format!(
            "x-apple.systempreferences:com.apple.preference.security?{pane}"
        ))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
