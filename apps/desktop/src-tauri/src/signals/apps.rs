//! The frontmost app (NSWorkspace) and its frontmost window's title (CGWindowList).
//!
//! Emits on change, checked once a second, plus a heartbeat every 30 s so a long single-app
//! stretch is still visible. Window titles need Screen Recording; without it the title is simply
//! absent. A browser title is turned into a best-effort site, marked low confidence — a title is
//! not a URL.

use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::{array_at, array_len, cfstr, dict_get, emit, i64_of, string_of, Owned, Signal};

#[derive(Clone, PartialEq, Eq, Default)]
pub struct Frontmost {
    pub bundle_id: String,
    pub name: String,
    pub pid: i32,
}

/// The latest frontmost app, shared with the screen sampler's deny list.
pub static CURRENT: Mutex<Option<Frontmost>> = Mutex::new(None);

pub fn spawn(app: AppHandle) {
    thread::Builder::new()
        .name("heli-apps".into())
        .spawn(move || run(app))
        .expect("spawn the app sampler");
}

fn run(app: AppHandle) {
    let mut last_app: Option<Frontmost> = None;
    let mut last_title: Option<String> = None;
    let mut heartbeat = Instant::now();
    loop {
        if let Some(front) = frontmost() {
            let changed = last_app.as_ref() != Some(&front);
            if changed || heartbeat.elapsed() >= Duration::from_secs(30) {
                emit(
                    &app,
                    Signal::new(
                        "app",
                        if changed {
                            "app.frontmost"
                        } else {
                            "app.heartbeat"
                        },
                        1.0,
                    )
                    .with("bundleId", front.bundle_id.clone())
                    .with("name", front.name.clone())
                    .with("pid", front.pid),
                );
                heartbeat = Instant::now();
            }
            if let Ok(mut current) = CURRENT.lock() {
                *current = Some(front.clone());
            }

            let title = window_title(front.pid);
            if changed || title != last_title {
                if let Some(t) = &title {
                    let mut s = Signal::new("window", "window.title", 0.9)
                        .with("title", t.clone())
                        .with("owner", front.name.clone());
                    if is_browser(&front.bundle_id) {
                        s.confidence = 0.5;
                        s = s.with("site", site_from_title(t, &front.name));
                    }
                    emit(&app, s);
                }
                last_title = title;
            }
            last_app = Some(front);
        }
        thread::sleep(Duration::from_secs(1));
    }
}

/* ---- NSWorkspace, through the Objective-C runtime -------------------------------------------- */

type Id = *mut c_void;

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> Id;
    fn sel_registerName(name: *const c_char) -> Id;
    fn objc_msgSend();
    fn objc_autoreleasePoolPush() -> *mut c_void;
    fn objc_autoreleasePoolPop(pool: *mut c_void);
}

#[link(name = "AppKit", kind = "framework")]
extern "C" {}

unsafe fn sel(name: &str) -> Id {
    let c = CString::new(name).unwrap_or_default();
    sel_registerName(c.as_ptr())
}

unsafe fn send_id(obj: Id, name: &str) -> Id {
    let f: extern "C" fn(Id, Id) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, sel(name))
}

unsafe fn send_i32(obj: Id, name: &str) -> i32 {
    let f: extern "C" fn(Id, Id) -> i32 = std::mem::transmute(objc_msgSend as *const c_void);
    f(obj, sel(name))
}

unsafe fn nsstring(obj: Id) -> Option<String> {
    if obj.is_null() {
        return None;
    }
    let f: extern "C" fn(Id, Id) -> *const c_char =
        std::mem::transmute(objc_msgSend as *const c_void);
    let p = f(obj, sel("UTF8String"));
    (!p.is_null()).then(|| CStr::from_ptr(p).to_string_lossy().into_owned())
}

pub fn frontmost() -> Option<Frontmost> {
    unsafe {
        let pool = objc_autoreleasePoolPush();
        let class = CString::new("NSWorkspace").ok()?;
        let workspace = send_id(objc_getClass(class.as_ptr()), "sharedWorkspace");
        let app = send_id(workspace, "frontmostApplication");
        let out = (!app.is_null()).then(|| Frontmost {
            bundle_id: nsstring(send_id(app, "bundleIdentifier")).unwrap_or_default(),
            name: nsstring(send_id(app, "localizedName")).unwrap_or_default(),
            pid: send_i32(app, "processIdentifier"),
        });
        objc_autoreleasePoolPop(pool);
        out
    }
}

/* ---- CGWindowList ---------------------------------------------------------------------------- */

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *const c_void;
}

const ON_SCREEN_ONLY: u32 = 1;
const EXCLUDE_DESKTOP: u32 = 16;

/// The title of the front-most normal window owned by `pid`, front to back.
fn window_title(pid: i32) -> Option<String> {
    let list = Owned(unsafe { CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0) });
    if list.0.is_null() {
        return None;
    }
    let (k_pid, k_layer, k_name) = (
        cfstr("kCGWindowOwnerPID"),
        cfstr("kCGWindowLayer"),
        cfstr("kCGWindowName"),
    );
    for i in 0..array_len(list.0) {
        let w = array_at(list.0, i);
        if i64_of(dict_get(w, &k_pid)) != Some(pid as i64)
            || i64_of(dict_get(w, &k_layer)) != Some(0)
        {
            continue;
        }
        // Without Screen Recording, macOS omits the name: the title is absent, not an error.
        return string_of(dict_get(w, &k_name)).filter(|t| !t.is_empty());
    }
    None
}

const BROWSERS: [&str; 7] = [
    "com.apple.Safari",
    "com.google.Chrome",
    "company.thebrowser.Browser",
    "org.mozilla.firefox",
    "com.brave.Browser",
    "com.microsoft.edgemac",
    "com.operasoftware.Opera",
];

fn is_browser(bundle_id: &str) -> bool {
    BROWSERS.contains(&bundle_id)
}

const KNOWN: [(&str, &str); 16] = [
    ("youtube", "youtube.com"),
    ("github", "github.com"),
    ("reddit", "reddit.com"),
    (" / x", "x.com"),
    ("twitter", "x.com"),
    ("instagram", "instagram.com"),
    ("tiktok", "tiktok.com"),
    ("netflix", "netflix.com"),
    ("hacker news", "news.ycombinator.com"),
    ("stack overflow", "stackoverflow.com"),
    ("wikipedia", "wikipedia.org"),
    ("khan academy", "khanacademy.org"),
    ("mit opencourseware", "ocw.mit.edu"),
    ("gmail", "mail.google.com"),
    ("google docs", "docs.google.com"),
    ("notion", "notion.so"),
];

/// "Linear algebra – Khan Academy — Google Chrome" → "khanacademy.org".
pub fn site_from_title(title: &str, app_name: &str) -> String {
    let lower = title.to_lowercase();
    for (needle, site) in KNOWN {
        if lower.contains(needle) {
            return site.to_string();
        }
    }
    let trimmed = title
        .trim_end_matches(&format!(" — {app_name}"))
        .trim_end_matches(&format!(" - {app_name}"));
    trimmed
        .rsplit(['—', '|', '-', '·'])
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::site_from_title;

    #[test]
    fn browser_titles_become_sites() {
        assert_eq!(
            site_from_title("Linear algebra | Khan Academy", "Safari"),
            "khanacademy.org"
        );
        assert_eq!(
            site_from_title("(3) lofi beats - YouTube — Google Chrome", "Google Chrome"),
            "youtube.com"
        );
        // Unknown sites fall back to the title's last segment — low confidence, by design.
        assert_eq!(
            site_from_title("Pull requests · heli/helicopter", "Safari"),
            "heli/helicopter"
        );
    }
}
