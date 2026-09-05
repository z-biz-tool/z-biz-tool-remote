// Persistent app state stored in the user's home directory.
//
// Path: $HOME/.z-biz-tool-remote/state.json
//
// Why not Tauri's app data dir? The user wants this in `~/.z-biz-tool-remote`
// so it survives WebView storage being wiped (e.g. origin changes after
// tauri.conf.json updates) and so users can find / back it up easily.
//
// Why not SQLite / encryption-at-rest? Single-user tool, low value, keeps
// the Rust dep surface small. File mode 0600 on the JSON file is good enough
// for "not accidentally world-readable".

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::Mutex;

const DIR_NAME: &str = ".z-biz-tool-remote";
const FILE_NAME: &str = "state.json";

// Serialize all writes to state.json. Without this, two concurrent
// `write_persistent_state` calls (e.g. hydration + REGISTER_SUCCESS firing
// in quick succession) can race their atomic-rename step, and the older
// snapshot can win if its rename lands second.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// The on-disk state shape. Tolerant of new fields being added over time —
/// missing fields default to None / empty.
///
/// `rename_all = "camelCase"` so the frontend (which uses JS naming) can
/// pass objects with `deviceId`, `serverUrl`, etc. Without this, serde
/// silently leaves mismatched fields at `Default::default()` (= `None`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistentState {
    /// Schema version. Bump when fields change meaning.
    #[serde(default = "default_version")]
    pub version: u32,
    /// Access + refresh token + user info.
    #[serde(default)]
    pub auth: Option<serde_json::Value>,
    /// Stable per-install device id (random, persisted).
    #[serde(default)]
    pub device_id: Option<String>,
    /// Last selected server URL.
    #[serde(default)]
    pub server_url: Option<String>,
    /// Saved server presets (URLs only — tokens are NOT persisted here).
    #[serde(default)]
    pub server_presets: Option<serde_json::Value>,
    /// Settings overrides (frameQuality, fps, etc).
    #[serde(default)]
    pub settings: Option<serde_json::Value>,
    /// Recent session history.
    #[serde(default)]
    pub history: Option<serde_json::Value>,
    /// Trusted device ids (auto-accept control requests).
    #[serde(default)]
    pub trusted: Option<serde_json::Value>,
    /// Last write timestamp (ms since epoch).
    #[serde(default)]
    pub updated_at: Option<i64>,
}

fn default_version() -> u32 {
    1
}

fn state_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "HOME environment variable not set".to_string())?;
    Ok(PathBuf::from(home).join(DIR_NAME))
}

fn state_file() -> Result<PathBuf, String> {
    Ok(state_dir()?.join(FILE_NAME))
}

fn ensure_dir() -> Result<PathBuf, String> {
    let dir = state_dir()?;
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("mkdir {} failed: {}", dir.display(), e))?;
        // Mode 0700 — owner only.
        let perm = fs::Permissions::from_mode(0o700);
        fs::set_permissions(&dir, perm)
            .map_err(|e| format!("chmod 0700 {} failed: {}", dir.display(), e))?;
    }
    Ok(dir)
}

#[tauri::command]
pub fn get_state_path() -> Result<String, String> {
    Ok(state_file()?.to_string_lossy().into_owned())
}

/// Read the persistent state. Returns `Ok(None)` if the file does not exist.
/// Returns `Ok(Some(default))` if the file exists but is empty / corrupt.
#[tauri::command]
pub fn read_persistent_state() -> Result<Option<PersistentState>, String> {
    let _guard = WRITE_LOCK.lock().map_err(|e| format!("lock poisoned: {}", e))?;
    let path = state_file()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("read {} failed: {}", path.display(), e))?;
    if raw.trim().is_empty() {
        return Ok(None);
    }
    match serde_json::from_str::<PersistentState>(&raw) {
        Ok(state) => Ok(Some(state)),
        Err(e) => {
            // Corrupt file: log + return None so caller falls back to localStorage.
            eprintln!(
                "[persistent_storage] state.json corrupt ({}), ignoring: {}",
                e,
                path.display()
            );
            Ok(None)
        }
    }
}

/// Write the persistent state atomically: write to a temp file in the same
/// directory, fsync, then rename. This prevents the file from being half-
/// written if the process is killed mid-write.
#[tauri::command]
pub fn write_persistent_state(state: PersistentState) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().map_err(|e| format!("lock poisoned: {}", e))?;
    let dir = ensure_dir()?;
    let path = dir.join(FILE_NAME);
    let tmp = dir.join(format!("{}.tmp", FILE_NAME));

    let mut stamped = state;
    stamped.updated_at = Some(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    );
    stamped.version = 1;

    let json = serde_json::to_string_pretty(&stamped)
        .map_err(|e| format!("serialize state failed: {}", e))?;

    {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .custom_flags(0o600)
            .open(&tmp)
            .map_err(|e| format!("open {} failed: {}", tmp.display(), e))?;
        f.write_all(json.as_bytes())
            .map_err(|e| format!("write {} failed: {}", tmp.display(), e))?;
        f.sync_all()
            .map_err(|e| format!("fsync {} failed: {}", tmp.display(), e))?;
    }
    // Restrict the temp file too in case the rename is racy on some FS.
    let perm = fs::Permissions::from_mode(0o600);
    fs::set_permissions(&tmp, perm)
        .map_err(|e| format!("chmod 0600 {} failed: {}", tmp.display(), e))?;

    fs::rename(&tmp, &path)
        .map_err(|e| format!("rename {} -> {} failed: {}", tmp.display(), path.display(), e))?;
    Ok(())
}

#[tauri::command]
pub fn clear_persistent_state() -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().map_err(|e| format!("lock poisoned: {}", e))?;
    let path = state_file()?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| format!("remove {} failed: {}", path.display(), e))?;
    }
    Ok(())
}
