// 本地烟雾测试：xcap 截屏 + enigo 初始化
// 跑：cargo run --example smoke --manifest-path src-tauri/Cargo.toml
use std::fs;
use std::time::Instant;
use xcap::Monitor;
use xcap::image::ExtendedColorType;
use xcap::image::ImageEncoder;
use xcap::image::codecs::jpeg::JpegEncoder;
use enigo::{Enigo, Settings};

fn main() {
    println!("=== z-biz-tool-remote smoke test ===\n");

    println!("[1] xcap: list monitors");
    let monitors = match Monitor::all() {
        Ok(m) => m,
        Err(e) => {
            println!("    FAIL: {e}");
            println!("    (xcap 需要 屏幕录制 权限)");
            std::process::exit(1);
        }
    };
    println!("    found {} monitor(s):", monitors.len());
    for m in &monitors {
        let w = m.width().unwrap_or(0);
        let h = m.height().unwrap_or(0);
        let prim = m.is_primary().unwrap_or(false);
        let name = m.name().unwrap_or_default();
        println!("      - {name}  {w}x{h}  primary={prim}");
    }

    let primary = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .expect("no monitor");

    println!("[2] xcap: capture one frame from primary");
    let t0 = Instant::now();
    let image = match primary.capture_image() {
        Ok(img) => img,
        Err(e) => {
            println!("    FAIL: {e}");
            println!("    (xcap 需要 屏幕录制 权限 - 系统设置 > 隐私与安全 > 屏幕录制)");
            std::process::exit(2);
        }
    };
    let (w, h) = image.dimensions();
    let dt = t0.elapsed();
    println!("    captured {w}x{h} in {dt:?}");

    println!("[3] encode to JPEG (quality 80)");
    let rgb = xcap::image::DynamicImage::ImageRgba8(image.clone()).to_rgb8();
    let mut buf: Vec<u8> = Vec::new();
    let encoder = JpegEncoder::new_with_quality(&mut buf, 80);
    if let Err(e) = encoder.write_image(rgb.as_raw(), w, h, ExtendedColorType::Rgb8) {
        println!("    FAIL: {e}");
        std::process::exit(3);
    }
    println!("    jpeg size: {} bytes ({:.1} KB)", buf.len(), buf.len() as f64 / 1024.0);

    let out = "/tmp/zbt-smoke-capture.jpg";
    fs::write(out, &buf).expect("write jpeg");
    println!("    saved to {out}");

    println!("[4] check pixels: any non-black?");
    let mut non_black = 0u64;
    for px in image.as_raw().chunks(4).take(10000) {
        if px[0] > 5 || px[1] > 5 || px[2] > 5 {
            non_black += 1;
        }
    }
    println!("    {non_black}/10000 pixels are non-black");
    if non_black == 0 {
        println!("    !! 截到全黑屏，大概率是 屏幕录制 权限没给到 terminal 进程");
    } else {
        println!("    ✓ 截屏看起来正常");
    }

    println!("\n[5] enigo: initialize (no input injected)");
    let eg = match Enigo::new(&Settings::default()) {
        Ok(e) => e,
        Err(e) => {
            println!("    FAIL: {e}");
            println!("    (enigo 初始化失败，macOS 一般不阻塞此步)");
            std::process::exit(4);
        }
    };
    drop(eg);
    println!("    enigo initialized OK");

    println!("\nALL SMOKE CHECKS PASSED ✓");
}
