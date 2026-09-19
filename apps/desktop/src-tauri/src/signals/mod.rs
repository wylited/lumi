//! Native signals: read-only, consent-gated, counts and titles only.
//!
//! Each submodule samples one thing on its own thread and hands `Signal`s to `emit`, which sends
//! them to the webview as `heli://signal`. The webview batches them to the server. A signal whose
//! permission is missing is simply never produced — no error, no retry spam.

pub mod apps;
pub mod input;
pub mod permissions;
pub mod screen;

use std::ffi::{c_char, c_void, CString};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// The contract's `Signal` (packages/contracts/src/signal.ts), as it leaves the process.
#[derive(Clone, Serialize)]
pub struct Signal {
    pub source: &'static str,
    pub kind: &'static str,
    pub ts: String,
    pub confidence: f32,
    pub payload: serde_json::Map<String, serde_json::Value>,
}

impl Signal {
    pub fn new(source: &'static str, kind: &'static str, confidence: f32) -> Self {
        Signal {
            source,
            kind,
            ts: iso_now(),
            confidence,
            payload: serde_json::Map::new(),
        }
    }

    pub fn with(mut self, key: &str, value: impl Into<serde_json::Value>) -> Self {
        self.payload.insert(key.to_string(), value.into());
        self
    }
}

pub fn emit(app: &AppHandle, signal: Signal) {
    // `LUMI_TRACE_SIGNALS=1` prints each signal as it leaves, for checking the modules by hand.
    if std::env::var_os("LUMI_TRACE_SIGNALS").is_some() {
        if let Ok(line) = serde_json::to_string(&signal) {
            eprintln!("signal {line}");
        }
    }
    let _ = app.emit("heli://signal", signal);
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    apps::spawn(app.clone());
    input::spawn(app.clone());
    screen::spawn(app.clone());
    Ok(())
}

/// RFC 3339, UTC, millisecond precision — without pulling in a date crate.
pub fn iso_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Howard Hinnant's civil-from-days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        now.subsec_millis()
    )
}

/* ---- the little CoreFoundation the signal modules share ----------------------------------- */

pub type CFTypeRef = *const c_void;

const UTF8: u32 = 0x0800_0100;
const CF_NUMBER_SINT64: isize = 4;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFStringCreateWithCString(alloc: CFTypeRef, s: *const c_char, enc: u32) -> CFTypeRef;
    fn CFStringGetLength(s: CFTypeRef) -> isize;
    fn CFStringGetCString(s: CFTypeRef, buf: *mut c_char, size: isize, enc: u32) -> bool;
    fn CFNumberGetValue(n: CFTypeRef, ty: isize, out: *mut c_void) -> bool;
    fn CFArrayGetCount(a: CFTypeRef) -> isize;
    fn CFArrayGetValueAtIndex(a: CFTypeRef, i: isize) -> CFTypeRef;
    fn CFDictionaryGetValue(d: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
}

/// An owned CF object, released on drop.
pub struct Owned(pub CFTypeRef);

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}

pub fn cfstr(s: &str) -> Owned {
    let c = CString::new(s).unwrap_or_default();
    Owned(unsafe { CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), UTF8) })
}

pub fn string_of(cf: CFTypeRef) -> Option<String> {
    unsafe {
        if cf.is_null() || CFGetTypeID(cf) != CFStringGetTypeID() {
            return None;
        }
        let cap = CFStringGetLength(cf) * 4 + 1;
        let mut buf = vec![0 as c_char; cap as usize];
        if !CFStringGetCString(cf, buf.as_mut_ptr(), cap, UTF8) {
            return None;
        }
        Some(
            std::ffi::CStr::from_ptr(buf.as_ptr())
                .to_string_lossy()
                .into_owned(),
        )
    }
}

pub fn i64_of(cf: CFTypeRef) -> Option<i64> {
    unsafe {
        if cf.is_null() || CFGetTypeID(cf) != CFNumberGetTypeID() {
            return None;
        }
        let mut out: i64 = 0;
        CFNumberGetValue(cf, CF_NUMBER_SINT64, &mut out as *mut i64 as *mut c_void).then_some(out)
    }
}

pub fn array_len(a: CFTypeRef) -> isize {
    unsafe { CFArrayGetCount(a) }
}

pub fn array_at(a: CFTypeRef, i: isize) -> CFTypeRef {
    unsafe { CFArrayGetValueAtIndex(a, i) }
}

pub fn dict_get(d: CFTypeRef, key: &Owned) -> CFTypeRef {
    unsafe { CFDictionaryGetValue(d, key.0) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_now_is_rfc3339_utc() {
        let s = iso_now();
        assert_eq!(s.len(), 24, "{s}");
        assert!(
            s.ends_with('Z') && &s[4..5] == "-" && &s[10..11] == "T",
            "{s}"
        );
    }

    /// Calls the real macOS APIs. Prints what a sample would carry; asserts only that nothing panics.
    #[test]
    fn samples_the_machine() {
        let front = apps::frontmost();
        let perms = permissions::permissions();
        let idle = input::idle_seconds();
        println!(
            "frontmost: {:?}",
            front.as_ref().map(|f| (&f.bundle_id, &f.name, f.pid))
        );
        println!("idle: {idle:.1}s");
        for p in perms {
            println!("{}: {}", p.id, p.state);
        }
    }
}
