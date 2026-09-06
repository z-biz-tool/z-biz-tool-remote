use crate::capture;
use crate::input::{self, InputEvent};
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ScreenFrame {
    pub base64: String,
    pub width: u32,
    pub height: u32,
    pub timestamp: i64,
    pub display_id: u32,
}

/// 截取主屏幕一帧并返回 JPEG/base64
///
/// `max_width` 为 0 时按原图输出；大于 0 时按等比例缩小后再编码，
/// 显著降低单帧字节数，缓解高分辨率显示器下的卡顿。
#[tauri::command]
pub fn capture_screen(quality: u8, max_width: u32) -> Result<ScreenFrame, String> {
    let frame = capture::capture_to_jpeg(quality, max_width)?;
    Ok(ScreenFrame {
        base64: frame.base64,
        width: frame.width,
        height: frame.height,
        timestamp: chrono::Utc::now().timestamp_millis(),
        display_id: frame.display_id,
    })
}

/// 截取指定显示器一帧并返回 JPEG/base64
#[tauri::command]
pub fn capture_monitor(display_id: u32, quality: u8, max_width: u32) -> Result<ScreenFrame, String> {
    let frame = capture::capture_monitor_to_jpeg(display_id, quality, max_width)?;
    Ok(ScreenFrame {
        base64: frame.base64,
        width: frame.width,
        height: frame.height,
        timestamp: chrono::Utc::now().timestamp_millis(),
        display_id: frame.display_id,
    })
}

/// 枚举显示器
#[tauri::command]
pub fn list_displays() -> Result<Vec<capture::DisplayInfo>, String> {
    capture::list_displays()
}

/// 派发来自控制端的输入事件
#[tauri::command]
pub fn simulate_input(event: InputEvent) -> Result<(), String> {
    input::dispatch(event)
}

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub platform: &'static str,
}

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
    }
}

// 新增：发送系统通知（用于聊天消息等）
#[tauri::command]
pub fn send_system_notification(
    app: tauri::AppHandle,
    message: String,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title("远程控制通知")
            .body(message)
            .show()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
