// The music pill's shared types and commands.
//
// Windows reads every player from the system media controls (media_win.rs):
// Apple Music, Spotify and any other app, through these commands and events.

use serde::Serialize;
use tauri::AppHandle;

pub const PILL_ID: &str = "integration_spotify";

// ── State ─────────────────────────────────────────────────────────────────────

/// The track Spotify has loaded (SpotifyTrack on macOS).
#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// spotify:track:…, spotify:episode:…, spotify:ad:… — the Mac's ids.
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    /// Seconds.
    pub duration: f64,
    pub art_url: Option<String>,
    /// mpris:trackid as Spotify gave it, for SetPosition.
    #[serde(skip)]
    pub object_path: String,
}

/// What the island is told, whenever it changes.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    /// The pill this player shows on: integration_spotify, and on Windows
    /// also integration_music (Apple Music) or integration_media (any app).
    pub source: String,
    /// The player's name ("Apple Music", "Edge"…), empty on Linux.
    pub app: String,
    /// Spotify owns its name on the bus.
    pub running: bool,
    /// A `spotify` (or the Flatpak / Snap) is there to launch.
    pub installed: bool,
    pub track: Option<Track>,
    pub playing: bool,
    /// Seconds at `position_at`; while playing, the real position runs on from there.
    pub position: f64,
    /// Unix milliseconds.
    pub position_at: f64,
    pub shuffle: bool,
    /// LoopStatus is not "None" (the Mac's `repeating`).
    pub repeat: bool,
    /// 0…100.
    pub volume: i32,
}

impl Default for PlayerState {
    fn default() -> Self {
        PlayerState {
            source: PILL_ID.to_string(),
            app: String::new(),
            running: false,
            installed: false,
            track: None,
            playing: false,
            position: 0.0,
            position_at: 0.0,
            shuffle: false,
            repeat: false,
            volume: 50,
        }
    }
}

/// "Song - Remastered 2011 (Live) [Mono]" → "Song" (SpotifyController.shortTitle).
pub fn short_title(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let mut s: &str = raw;
    if let Some(i) = s.find(" - ") {
        s = &s[..i];
    }
    loop {
        let t = s.trim();
        let Some(last) = t.chars().last() else { break };
        if last != ')' && last != ']' {
            break;
        }
        let open = if last == ')' { '(' } else { '[' };
        let Some(idx) = t.rfind(open) else { break };
        let candidate = t[..idx].trim();
        if candidate.is_empty() {
            break;
        }
        s = candidate;
    }
    let result = s.trim();
    if result.is_empty() { raw.to_string() } else { result.to_string() }
}

/// "Artist feat. Someone" → "Artist" (SpotifyController.shortArtist).
pub fn short_artist(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let lower = raw.to_lowercase();
    for tag in [" feat.", " ft."] {
        if let Some(i) = lower.find(tag) {
            // Lowercasing can move byte offsets; only cut where it lines up.
            if lower.len() == raw.len() && raw.is_char_boundary(i) {
                let result = raw[..i].trim();
                return if result.is_empty() { raw.to_string() } else { result.to_string() };
            }
        }
    }
    raw.to_string()
}

// ── Artwork ───────────────────────────────────────────────────────────────────

/// The image type, from its first bytes — never from what the file claims.
pub fn sniff_image(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else {
        None
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// The player as it is now, read again from Spotify (the card coming on
/// screen: seeks made in Spotify's own window are never signalled).
#[tauri::command]
pub async fn spotify_refresh(app: AppHandle) -> Option<PlayerState> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || crate::media_win::refresh(&app)).await.ok().flatten()
    }
}

/// A control from the card or the pill: `playPause`, `next`, `previous`,
/// `seek` (seconds), `shuffle` / `repeat` (1 on, 0 off), `volume` (0…100).
#[tauri::command]
pub async fn spotify_control(app: AppHandle, action: String, value: Option<f64>) -> bool {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || crate::media_win::control(&app, &action, value)).await.unwrap_or(false)
    }
}

/// "Open Spotify": brings it forward, or starts it. Without Spotify, its
/// download page. True when Spotify was reached or started.
#[tauri::command]
pub async fn spotify_open() -> bool {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(crate::media_win::open).await.unwrap_or(false)
    }
}

/// For Settings: whether there is a player to launch for this pill.
#[tauri::command]
pub fn spotify_installed(pill: Option<String>) -> bool {
    #[cfg(windows)]
    {
        crate::media_win::installed_for(pill.as_deref().unwrap_or(PILL_ID))
    }
}

/// Starts the listener when the pill is declared, stops it when it is not.
/// Called at launch and after every settings save.
pub fn sync(app: &AppHandle, active_integrations: &[String]) {
    #[cfg(windows)]
    crate::media_win::sync(app, active_integrations);
}

// ── Tests (the pure parts) ────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_and_artists_are_cut_like_the_mac() {
        assert_eq!(short_title("Song - Remastered 2011"), "Song");
        assert_eq!(short_title("Song (Live) [Mono]"), "Song");
        assert_eq!(short_title("(Intro)"), "(Intro)");
        assert_eq!(short_title(""), "");
        assert_eq!(short_title("Plain"), "Plain");
        assert_eq!(short_artist("Artist feat. Someone"), "Artist");
        assert_eq!(short_artist("Artist FT. Someone"), "Artist");
        assert_eq!(short_artist("Solo"), "Solo");
    }

    #[test]
    fn the_state_reaches_the_page_in_camel_case() {
        let track = Track { id: "spotify:track:ID1".into(), art_url: Some("https://i.scdn.co/image/abc".into()), object_path: "/x".into(), ..Track::default() };
        let state = PlayerState { track: Some(track), position_at: 7.0, ..PlayerState::default() };
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json["positionAt"], 7.0);
        assert_eq!(json["track"]["artUrl"], "https://i.scdn.co/image/abc");
        assert_eq!(json["track"]["id"], "spotify:track:ID1");
        assert!(json["track"].get("objectPath").is_none());
    }

    #[test]
    fn images_are_typed_by_their_bytes() {
        assert_eq!(sniff_image(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"GIF89a.."), Some("image/gif"));
        assert_eq!(sniff_image(b"<svg xmlns="), None);
    }
}
