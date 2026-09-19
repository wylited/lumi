//! Input cadence and idle — the signal that separates "reading a page" from "gone for coffee".
//!
//! A listen-only `CGEventTap` counts key-downs and clicks. The callback looks at the event *type*
//! and nothing else: it never reads a key code, a character, or a position, and it returns every
//! event untouched. What leaves this module is a rate per 30 s and a burst flag.
//!
//! Idle comes from `CGEventSourceSecondsSinceLastEventType`, which needs no permission.

use std::ffi::c_void;
use std::sync::atomic::{AtomicPtr, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use super::{emit, permissions, CFTypeRef, Signal};

static KEYS: AtomicU64 = AtomicU64::new(0);
static CLICKS: AtomicU64 = AtomicU64::new(0);
static TAP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

const KEY_DOWN: u32 = 10;
const LEFT_DOWN: u32 = 1;
const RIGHT_DOWN: u32 = 3;
const OTHER_DOWN: u32 = 25;
const TAP_DISABLED_BY_TIMEOUT: u32 = 0xFFFF_FFFE;
const TAP_DISABLED_BY_USER: u32 = 0xFFFF_FFFF;

const SESSION_TAP: u32 = 1;
const HEAD_INSERT: u32 = 0;
const LISTEN_ONLY: u32 = 1;
const COMBINED_STATE: i32 = 0;
const ANY_INPUT: u32 = u32::MAX;

type TapCallback = extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events: u64,
        callback: TapCallback,
        refcon: *mut c_void,
    ) -> *mut c_void;
    fn CGEventTapEnable(tap: *mut c_void, enable: bool);
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopCommonModes: CFTypeRef;
    fn CFMachPortCreateRunLoopSource(
        alloc: CFTypeRef,
        port: *mut c_void,
        order: isize,
    ) -> CFTypeRef;
    fn CFRunLoopGetCurrent() -> CFTypeRef;
    fn CFRunLoopAddSource(rl: CFTypeRef, source: CFTypeRef, mode: CFTypeRef);
    fn CFRunLoopRun();
}

/// Only the event type is inspected. The event itself is passed through unread.
extern "C" fn on_event(
    _proxy: *mut c_void,
    ty: u32,
    event: *mut c_void,
    _refcon: *mut c_void,
) -> *mut c_void {
    match ty {
        KEY_DOWN => {
            KEYS.fetch_add(1, Ordering::Relaxed);
        }
        LEFT_DOWN | RIGHT_DOWN | OTHER_DOWN => {
            CLICKS.fetch_add(1, Ordering::Relaxed);
        }
        TAP_DISABLED_BY_TIMEOUT | TAP_DISABLED_BY_USER => {
            let tap = TAP.load(Ordering::Relaxed);
            if !tap.is_null() {
                unsafe { CGEventTapEnable(tap, true) };
            }
        }
        _ => {}
    }
    event
}

pub fn spawn(app: AppHandle) {
    thread::Builder::new()
        .name("heli-input-tap".into())
        .spawn(tap_loop)
        .expect("spawn the input tap");
    thread::Builder::new()
        .name("heli-input".into())
        .spawn(move || sample(app))
        .expect("spawn the input sampler");
}

/// Installs the tap once Input Monitoring is granted, then runs its run loop forever.
fn tap_loop() {
    while !permissions::input_monitoring() {
        thread::sleep(Duration::from_secs(10));
    }
    let mask = (1u64 << KEY_DOWN) | (1 << LEFT_DOWN) | (1 << RIGHT_DOWN) | (1 << OTHER_DOWN);
    let tap = unsafe {
        CGEventTapCreate(
            SESSION_TAP,
            HEAD_INSERT,
            LISTEN_ONLY,
            mask,
            on_event,
            std::ptr::null_mut(),
        )
    };
    if tap.is_null() {
        // Granted after launch: macOS only honours it for a fresh process. Stay silent.
        return;
    }
    TAP.store(tap, Ordering::Relaxed);
    unsafe {
        let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
        CGEventTapEnable(tap, true);
        CFRunLoopRun();
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Idle {
    Active,
    Pause,
    Away,
}

impl Idle {
    fn of(seconds: f64) -> Self {
        if seconds < 15.0 {
            Idle::Active
        } else if seconds < 120.0 {
            Idle::Pause
        } else {
            Idle::Away
        }
    }

    fn name(self) -> &'static str {
        match self {
            Idle::Active => "active",
            Idle::Pause => "pause",
            Idle::Away => "away",
        }
    }
}

pub fn idle_seconds() -> f64 {
    unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_STATE, ANY_INPUT) }
}

/// Once a second: idle state on change. Every 5 s: the rolling 30 s input rate.
fn sample(app: AppHandle) {
    // Per-second counts for the last 30 s.
    let mut ring = [(0u64, 0u64); 30];
    let mut slot = 0usize;
    let (mut last_keys, mut last_clicks) = (0u64, 0u64);
    let mut idle_state: Option<Idle> = None;
    let mut last_rate = Instant::now();

    loop {
        thread::sleep(Duration::from_secs(1));

        let idle = idle_seconds();
        let state = Idle::of(idle);
        if idle_state != Some(state) {
            emit(
                &app,
                Signal::new("idle", "idle.state", 1.0)
                    .with("state", state.name())
                    .with("seconds", (idle * 10.0).round() / 10.0),
            );
            idle_state = Some(state);
        }

        if TAP.load(Ordering::Relaxed).is_null() {
            continue; // no Input Monitoring: the rate is absent, not zero
        }
        let (k, c) = (KEYS.load(Ordering::Relaxed), CLICKS.load(Ordering::Relaxed));
        ring[slot] = (k - last_keys, c - last_clicks);
        (last_keys, last_clicks) = (k, c);
        slot = (slot + 1) % ring.len();

        if last_rate.elapsed() >= Duration::from_secs(5) {
            last_rate = Instant::now();
            let keys: u64 = ring.iter().map(|r| r.0).sum();
            let clicks: u64 = ring.iter().map(|r| r.1).sum();
            // A burst: any 5 s stretch with 20+ key-downs.
            let burst = (0..ring.len())
                .any(|s| (0..5).map(|o| ring[(s + o) % ring.len()].0).sum::<u64>() >= 20);
            let activity = if keys >= 20 {
                "typing"
            } else if keys + clicks > 0 {
                "light"
            } else {
                "still"
            };
            emit(
                &app,
                Signal::new("input", "input.rate", 1.0)
                    .with("windowSeconds", 30)
                    .with("keys", keys)
                    .with("clicks", clicks)
                    .with("events", keys + clicks)
                    .with("burst", burst)
                    .with("activity", activity),
            );
        }
    }
}
