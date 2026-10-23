// Small append-only log at %LOCALAPPDATA%\app.cue.notch\cue.log — the
// equivalent of nbLog() in HookServer.swift. Nothing leaves the machine.

use std::io::Write;

use crate::platform;

pub fn line(message: impl AsRef<str>) {
    let t = platform::local_time();
    let stamp = format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    );
    let dir = platform::data_dir();
    if platform::ensure_private_dir(&dir).is_err() {
        return;
    }
    let path = dir.join("cue.log");
    // Keep it from growing forever: start fresh past ~1 MB.
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    // Readable by us only, like the macOS log.
    if let Ok(mut file) = options.open(path) {
        let _ = writeln!(file, "{stamp} {}", message.as_ref());
    }
}

/// The last `n` lines of the log, for "Copy log" in the tray menu: a bug that
/// only shows on someone else's PC needs what happened there.
pub fn tail(n: usize) -> String {
    let text = std::fs::read_to_string(platform::data_dir().join("cue.log")).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    let tail = lines[lines.len().saturating_sub(n)..].join("\n");
    format!("Cue {} on {}\n{tail}", env!("CARGO_PKG_VERSION"), std::env::consts::OS)
}
