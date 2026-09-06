use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use image::imageops::FilterType;
use serde::Serialize;
use xcap::Monitor;
use xcap::image::ExtendedColorType;
use xcap::image::ImageEncoder;
use xcap::image::RgbaImage;
use xcap::image::codecs::jpeg::JpegEncoder;

#[derive(Debug, Serialize)]
pub struct DisplayInfo {
    pub id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub is_primary: bool,
    pub x: i32,
    pub y: i32,
}

pub fn list_displays() -> Result<Vec<DisplayInfo>, String> {
    let monitors = Monitor::all().map_err(|e| format!("枚举显示器失败: {e}"))?;
    let mut out = Vec::with_capacity(monitors.len());
    for m in monitors {
        out.push(DisplayInfo {
            id: m.id().unwrap_or(0),
            name: m.name().unwrap_or_default(),
            width: m.width().unwrap_or(0),
            height: m.height().unwrap_or(0),
            is_primary: m.is_primary().unwrap_or(false),
            x: m.x().unwrap_or(0),
            y: m.y().unwrap_or(0),
        });
    }
    Ok(out)
}

pub struct CapturedFrame {
    pub base64: String,
    pub width: u32,
    pub height: u32,
    pub display_id: u32,
}

/// 按 max_width 等比例缩小,降低像素量与传输带宽。
/// - max_width == 0 表示按原图输出(用户选"原生")。
/// - 原图已经比 max_width 窄时不再放大。
fn downscale_to_width(rgb: RgbaImage, max_width: u32) -> RgbaImage {
    if max_width == 0 {
        return rgb;
    }
    let (w, h) = rgb.dimensions();
    if w <= max_width {
        return rgb;
    }
    // 按比例换算新高度,向上取整避免出现 0
    let scale = max_width as f64 / w as f64;
    let new_w = max_width;
    let new_h = ((h as f64) * scale).ceil() as u32;
    image::imageops::resize(&rgb, new_w, new_h, FilterType::Triangle)
}

/// 编码一帧到 JPEG/base64。
///
/// `max_width` 在编码前对 RGB 数据做一次三角滤波缩放,显著降低像素量。
fn encode_jpeg(rgb: RgbaImage, display_id: u32, quality: u8, max_width: u32) -> Result<CapturedFrame, String> {
    let rgb = downscale_to_width(rgb, max_width);
    let (w, h) = rgb.dimensions();
    let mut buf: Vec<u8> = Vec::new();
    let q = quality.clamp(10, 100);
    let encoder = JpegEncoder::new_with_quality(&mut buf, q);
    encoder
        .write_image(rgb.as_raw(), w, h, ExtendedColorType::Rgb8)
        .map_err(|e| format!("编码 JPEG 失败: {e}"))?;

    Ok(CapturedFrame {
        base64: BASE64.encode(&buf),
        width: w,
        height: h,
        display_id,
    })
}

pub fn capture_to_jpeg(quality: u8, max_width: u32) -> Result<CapturedFrame, String> {
    let monitors = Monitor::all().map_err(|e| format!("枚举显示器失败: {e}"))?;
    let primary = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .cloned()
        .or_else(|| monitors.first().cloned())
        .ok_or_else(|| "未找到可用显示器".to_string())?;

    let image: RgbaImage = primary
        .capture_image()
        .map_err(|e| format!("截屏失败: {e}"))?;

    encode_jpeg(image, primary.id().unwrap_or(0), quality, max_width)
}

// 新增：支持选择特定显示器截屏
pub fn capture_monitor_to_jpeg(display_id: u32, quality: u8, max_width: u32) -> Result<CapturedFrame, String> {
    let monitors = Monitor::all().map_err(|e| format!("枚举显示器失败: {e}"))?;
    let monitor = monitors
        .iter()
        .find(|m| m.id().unwrap_or(0) == display_id)
        .cloned()
        .ok_or_else(|| format!("未找到显示器 ID: {}", display_id))?;

    let image: RgbaImage = monitor
        .capture_image()
        .map_err(|e| format!("截屏失败: {e}"))?;

    encode_jpeg(image, monitor.id().unwrap_or(0), quality, max_width)
}
