//! The rig's own file, read-only. The rig agent (`apps/edge`) owns `~/.heli/rig.json`: its desk id,
//! its token and its calibration. The desktop only reads the calibrated rectangle, so "aim here" can
//! turn a rectangle drawn on the preview into millimetres on the desk. It never reads the token.

use serde::Serialize;

#[derive(Serialize)]
pub struct RectMm {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RigCalibration {
    pub rect_mm: Option<RectMm>,
    /// Pairs recorded; `arm.point` needs three.
    pub poses: usize,
}

#[tauri::command]
pub fn rig_calibration() -> Option<RigCalibration> {
    let home = std::env::var_os("HOME")?;
    let text = std::fs::read_to_string(std::path::Path::new(&home).join(".heli/rig.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    let calibration = json.get("calibration")?;
    let rect = calibration.get("rect_mm").and_then(|r| {
        Some(RectMm {
            x: r.get("x")?.as_f64()?,
            y: r.get("y")?.as_f64()?,
            w: r.get("w")?.as_f64()?,
            h: r.get("h")?.as_f64()?,
        })
    });
    let poses = calibration.get("poses").and_then(|p| p.as_array()).map_or(0, Vec::len);
    Some(RigCalibration { rect_mm: rect, poses })
}
