use enigo::Axis;
use enigo::Button;
use enigo::Coordinate;
use enigo::Direction;
use enigo::Enigo;
use enigo::Key;
use enigo::Keyboard;
use enigo::Mouse;
use enigo::Settings;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum InputEvent {
    MouseMove { x: i32, y: i32 },
    MouseDown { button: String },
    MouseUp { button: String },
    MouseWheel { delta_y: i32, delta_x: i32 },
    KeyDown { key: String },
    KeyUp { key: String },
    KeyType { text: String },
}

fn map_button(name: &str) -> Option<Button> {
    match name.to_ascii_lowercase().as_str() {
        "left" => Some(Button::Left),
        "right" => Some(Button::Right),
        "middle" => Some(Button::Middle),
        _ => None,
    }
}

/// 将 JS 端发来的 key 字符串映射为 enigo 的 Key
fn map_key(name: &str) -> Option<Key> {
    let lower = name.to_ascii_lowercase();
    match lower.as_str() {
        "enter" | "return" => Some(Key::Return),
        "tab" => Some(Key::Tab),
        "escape" | "esc" => Some(Key::Escape),
        "backspace" => Some(Key::Backspace),
        "delete" | "del" => Some(Key::Delete),
        "space" => Some(Key::Space),
        "shift" => Some(Key::Shift),
        "ctrl" | "control" => Some(Key::Control),
        "alt" | "option" => Some(Key::Alt),
        "meta" | "cmd" | "command" | "super" => Some(Key::Meta),
        "capslock" | "caps_lock" => Some(Key::CapsLock),
        "arrowup" | "up" => Some(Key::UpArrow),
        "arrowdown" | "down" => Some(Key::DownArrow),
        "arrowleft" | "left" => Some(Key::LeftArrow),
        "arrowright" | "right" => Some(Key::RightArrow),
        "home" => Some(Key::Home),
        "end" => Some(Key::End),
        "pageup" | "page_up" => Some(Key::PageUp),
        "pagedown" | "page_down" => Some(Key::PageDown),
        "f1" => Some(Key::F1),
        "f2" => Some(Key::F2),
        "f3" => Some(Key::F3),
        "f4" => Some(Key::F4),
        "f5" => Some(Key::F5),
        "f6" => Some(Key::F6),
        "f7" => Some(Key::F7),
        "f8" => Some(Key::F8),
        "f9" => Some(Key::F9),
        "f10" => Some(Key::F10),
        "f11" => Some(Key::F11),
        "f12" => Some(Key::F12),
        other if other.chars().count() == 1 => {
            let c = other.chars().next().unwrap();
            Some(Key::Unicode(c))
        }
        _ => None,
    }
}

pub fn dispatch(event: InputEvent) -> Result<(), String> {
    // Enigo 在 macOS 上不是 Send，所以每次现造。
    let mut eg = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;
    match event {
        InputEvent::MouseMove { x, y } => {
            eg.move_mouse(x, y, Coordinate::Abs)
                .map_err(|e| e.to_string())?;
        }
        InputEvent::MouseDown { button } => {
            let b = map_button(&button).ok_or_else(|| format!("未知鼠标按钮: {button}"))?;
            eg.button(b, Direction::Press).map_err(|e| e.to_string())?;
        }
        InputEvent::MouseUp { button } => {
            let b = map_button(&button).ok_or_else(|| format!("未知鼠标按钮: {button}"))?;
            eg.button(b, Direction::Release).map_err(|e| e.to_string())?;
        }
        InputEvent::MouseWheel { delta_y, delta_x } => {
            if delta_y != 0 {
                eg.scroll(delta_y, Axis::Vertical)
                    .map_err(|e| e.to_string())?;
            }
            if delta_x != 0 {
                eg.scroll(delta_x, Axis::Horizontal)
                    .map_err(|e| e.to_string())?;
            }
        }
        InputEvent::KeyDown { key } => {
            let k = map_key(&key).ok_or_else(|| format!("未知键: {key}"))?;
            eg.key(k, Direction::Press).map_err(|e| e.to_string())?;
        }
        InputEvent::KeyUp { key } => {
            let k = map_key(&key).ok_or_else(|| format!("未知键: {key}"))?;
            eg.key(k, Direction::Release).map_err(|e| e.to_string())?;
        }
        InputEvent::KeyType { text } => {
            eg.text(&text).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
