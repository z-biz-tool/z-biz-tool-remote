mod capture;
mod commands;
mod input;
mod persistent_storage;

use tauri::Manager;

pub fn run() {
    // 深链队列：既要 manage 给命令用，又要传给冷启动 seed —— 两处必须同一份。
    let zbiz_pending = cap_hub::receiver::SharedPending::default();

    tauri::Builder::default()
        // 单实例（2026-10-26 分发底座）：第二次启动聚焦已有窗口，不再开新进程。
        // 必须作为第一个注册的插件（tauri-plugin-single-instance 官方要求）。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            cap_hub::receiver::handle_second_instance(app, &argv);
        }))
        .manage(zbiz_pending.clone())
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
            zbiz_take_pending,
        ])
        .setup(move |app| {
            cap_hub::receiver::seed_cold_start(app.handle(), &zbiz_pending);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 取走队列里的深链（家族统一命令名）。
#[tauri::command]
fn zbiz_take_pending(
    pending: tauri::State<'_, cap_hub::receiver::SharedPending>,
) -> Vec<cap_hub::Handoff> {
    cap_hub::receiver::take_pending_from(pending.inner())
}
