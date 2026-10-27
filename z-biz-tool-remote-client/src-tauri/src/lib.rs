mod capture;
mod commands;
mod input;
mod persistent_storage;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        // 单实例（2026-10-26 分发底座）：第二次启动聚焦已有窗口，不再开新进程。
        // 必须作为第一个注册的插件（tauri-plugin-single-instance 官方要求）。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // 自动更新：前端 UpdaterGate 延时 check()，endpoint/pubkey 见 tauri.conf.json
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 更新安装完成后的「立即重启」
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            commands::capture_screen,
            commands::capture_monitor,
            commands::list_displays,
            commands::simulate_input,
            commands::get_app_info,
            commands::send_system_notification,
            persistent_storage::read_persistent_state,
            persistent_storage::write_persistent_state,
            persistent_storage::get_state_path,
            persistent_storage::clear_persistent_state,
        ])
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
