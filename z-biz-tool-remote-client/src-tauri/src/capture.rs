use serde::Serialize;
use xcap::Monitor;
use xcap::image::RgbaImage;

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

/// 编码一帧到 JPEG/base64，交给能力层 cap-img（等比缩放 + RGBA→RGB 转换 + JPEG 编码）。
///
/// 历史 bug（ecb895e 引入，2026-09-06 ~ 2026-09-25）：本函数曾把 `RgbaImage::as_raw()`
/// 的**4 通道**数据声明成 `ExtendedColorType::Rgb8` 交给 JPEG 编码器，image 0.25 直接
/// panic（"Invalid buffer length: expected N*3 got N*4"）——截屏功能全程不可用。
/// cap-img 侧的 `encode_frame_jpeg` 先做 `DynamicImage::ImageRgba8(..).to_rgb8()` 降通道，
/// 并对长度不符返回 Err 而非 panic。回归锚点见本文件测试与 cap-img 的
/// `frame_jpeg_wrong_channel_length_is_error_not_panic`。
fn encode_jpeg(
    rgba: RgbaImage,
    display_id: u32,
    quality: u8,
    max_width: u32,
) -> Result<CapturedFrame, String> {
    let (w, h) = rgba.dimensions();
    let frame = cap_img::encode_frame_jpeg(rgba.as_raw(), w, h, quality, max_width)?;
    Ok(CapturedFrame {
        base64: frame.base64,
        width: frame.width,
        height: frame.height,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一帧全 128 的 RGBA 图（与 xcap 真实采集到的形状一致：4 通道）
    fn rgba(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_raw(w, h, vec![128u8; (w * h * 4) as usize]).unwrap()
    }

    /// 回归锚点：ecb895e 把 4 通道数据声明成 Rgb8，image 0.25 直接 panic，
    /// 截屏自 2026-09-06 起全程不可用。改造后必须拿到可解码的 JPEG。
    #[test]
    fn encode_jpeg_encodes_rgba_frame_without_panic() {
        let frame = encode_jpeg(rgba(64, 48), 7, 80, 0).expect("合法帧必须编码成功");
        assert_eq!((frame.width, frame.height), (64, 48));
        assert_eq!(frame.display_id, 7);

        use base64::Engine;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(&frame.base64)
            .expect("base64 必须合法");
        assert_eq!(&raw[..2], &[0xFF, 0xD8], "应是 JPEG 魔数");
        let img = xcap::image::load_from_memory(&raw).expect("产物必须能被 image 解回来");
        assert_eq!((img.width(), img.height()), (64, 48));
    }

    /// 等比缩小语义由 cap-img 承担：0=原样、超宽才缩、高度向上取整
    #[test]
    fn encode_jpeg_honors_max_width() {
        let f0 = encode_jpeg(rgba(100, 33), 0, 80, 0).unwrap();
        assert_eq!((f0.width, f0.height), (100, 33));

        let f1 = encode_jpeg(rgba(100, 33), 0, 80, 50).unwrap();
        assert_eq!((f1.width, f1.height), (50, 17));

        // 原图已比 max_width 窄 → 不放大
        let f2 = encode_jpeg(rgba(100, 33), 0, 80, 500).unwrap();
        assert_eq!((f2.width, f2.height), (100, 33));
    }

    /// 长度不符必须返回 Err 而非 panic（cap-img 侧的守卫在本仓同样可达）
    #[test]
    fn encode_jpeg_rejects_mismatched_buffer() {
        // 3 通道数据冒充 4 通道：走 cap_img 的长度校验
        let short = vec![128u8; 64 * 48 * 3];
        let err = cap_img::encode_frame_jpeg(&short, 64, 48, 80, 0)
            .expect_err("长度不符应报错");
        assert!(err.contains("长度不符"), "实得 {}", err);
    }
}
