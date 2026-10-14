// What the notch's smaller moments need from the PC: a lyric sheet for the
// track that is playing, and how many bytes the network adapters have moved.
// The logic that reads them is in src/core/moments.ts.

use std::time::Duration;

// ── Lyrics ───────────────────────────────────────────────────────────────────

const LRCLIB: &str = "https://lrclib.net/api/get";
/// A lyric sheet is a few kilobytes; nothing bigger is read.
const LYRICS_LIMIT: usize = 256 * 1024;

/// The synced lyrics (LRC) of a track from LRCLIB, a free public database, or
/// None when it has none. Only asked for while the Lyrics switch is on: the
/// title and the artist of what is playing leave the PC for this.
#[tauri::command]
pub async fn lyrics(title: String, artist: String, album: String, duration: f64) -> Option<String> {
    if title.trim().is_empty() {
        return None;
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(concat!("Cue/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?;
    let mut query = vec![("track_name", title), ("artist_name", artist)];
    if !album.trim().is_empty() {
        query.push(("album_name", album));
    }
    if duration > 0.0 {
        query.push(("duration", format!("{}", duration.round() as u64)));
    }
    let response = client.get(LRCLIB).query(&query).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = crate::net::read_capped(response, LYRICS_LIMIT).await.ok()?;
    let json: serde_json::Value = serde_json::from_slice(&body).ok()?;
    json["syncedLyrics"].as_str().filter(|s| !s.trim().is_empty()).map(str::to_string)
}

// ── Network ──────────────────────────────────────────────────────────────────

/// Bytes received and sent since boot, summed over the real adapters. The page
/// asks every two seconds while the notch is on screen and turns the
/// difference into a rate.
#[derive(serde::Serialize)]
pub struct NetTotals {
    down: u64,
    up: u64,
}

#[tauri::command]
pub async fn net_totals() -> Option<NetTotals> {
    use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    const LOOPBACK: u32 = 24;
    /// InterfaceAndOperStatusFlags: a physical connector, not a filter or a virtual switch
    /// (those repeat the bytes of the adapter under them).
    const CONNECTOR_PRESENT: u8 = 0b100;
    unsafe {
        let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        if GetIfTable2(&mut table).is_err() || table.is_null() {
            return None;
        }
        let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        let mut totals = NetTotals { down: 0, up: 0 };
        for row in rows {
            let real = row.InterfaceAndOperStatusFlags._bitfield & CONNECTOR_PRESENT != 0;
            if real && row.Type != LOOPBACK && row.OperStatus == IfOperStatusUp {
                totals.down += row.InOctets;
                totals.up += row.OutOctets;
            }
        }
        FreeMibTable(table as *const _);
        Some(totals)
    }
}
