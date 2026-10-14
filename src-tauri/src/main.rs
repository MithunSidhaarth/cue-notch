// Cue runs without a console window: Cue is the whole UI.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    cue_lib::run()
}
