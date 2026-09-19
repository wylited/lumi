//! The focused element: its role and accessible title, through `AXUIElement`.
//!
//! "text field, Search", "button, Post". This module asks for exactly three attributes — the role
//! description, the title and the description — and **never** `AXValue`, `AXSelectedText` or any
//! attribute that carries what is typed or shown. A text field's contents do not leave this file,
//! because they are never read into it.
//!
//! Needs Accessibility; without it the signal is simply absent.

use std::ffi::c_void;
use std::thread;
use std::time::Duration;

use tauri::AppHandle;

use super::{cfstr, emit, permissions, string_of, CFTypeRef, Owned, Signal};

type AXUIElementRef = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFTypeRef,
        value: *mut CFTypeRef,
    ) -> i32;
}

const AX_SUCCESS: i32 = 0;

/// One attribute as an owned CF object, or None. Only ever called with the names below.
fn attribute(element: AXUIElementRef, name: &str) -> Option<Owned> {
    let key = cfstr(name);
    let mut out: CFTypeRef = std::ptr::null();
    let status = unsafe { AXUIElementCopyAttributeValue(element, key.0, &mut out) };
    (status == AX_SUCCESS && !out.is_null()).then(|| Owned(out))
}

#[derive(PartialEq, Eq, Clone)]
pub struct Focused {
    pub role: String,
    pub title: Option<String>,
}

/// The focused element's role description and its accessible title. Nothing else.
pub fn focused() -> Option<Focused> {
    let system = Owned(unsafe { AXUIElementCreateSystemWide() });
    let element = attribute(system.0, "AXFocusedUIElement")?;
    let role = attribute(element.0, "AXRoleDescription").and_then(|r| string_of(r.0))?;
    let title = attribute(element.0, "AXTitle")
        .and_then(|t| string_of(t.0))
        .filter(|t| !t.is_empty())
        .or_else(|| {
            attribute(element.0, "AXDescription")
                .and_then(|d| string_of(d.0))
                .filter(|d| !d.is_empty())
        });
    Some(Focused { role, title })
}

pub fn spawn(app: AppHandle) {
    thread::Builder::new()
        .name("heli-ax".into())
        .spawn(move || {
            let mut last: Option<Focused> = None;
            loop {
                thread::sleep(Duration::from_secs(1));
                if !permissions::accessibility() {
                    continue;
                }
                let now = focused();
                if now != last {
                    if let Some(f) = &now {
                        let mut s =
                            Signal::new("app", "focus.element", 0.9).with("role", f.role.clone());
                        if let Some(t) = &f.title {
                            // Titles are labels ("Search"), capped so a long label cannot smuggle text.
                            s = s.with("title", t.chars().take(60).collect::<String>());
                        }
                        emit(&app, s);
                    }
                    last = now;
                }
            }
        })
        .expect("spawn the focus sampler");
}

#[cfg(test)]
mod tests {
    /// The privacy promise, enforced: no attribute that carries content is ever requested.
    #[test]
    fn never_reads_content() {
        let source = include_str!("ax.rs");
        let code = source.split("#[cfg(test)]").next().unwrap_or(source);
        for forbidden in ["\"AXValue\"", "\"AXSelectedText\"", "\"AXVisibleText\"", "\"AXText\""] {
            assert!(!code.contains(forbidden), "ax.rs must never request {forbidden}");
        }
    }

    #[test]
    fn reads_the_focused_element() {
        if !super::permissions::accessibility() {
            return;
        }
        let f = super::focused();
        println!("focused: {:?}", f.as_ref().map(|f| (&f.role, &f.title)));
    }
}
