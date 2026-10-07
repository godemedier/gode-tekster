// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(e) = gode_tekster_lib::run() {
        // Ingen konsol i release; logfilen kommer i plan 1 (ADR-0006).
        eprintln!("Gode Tekster kunne ikke starte: {e}");
        std::process::exit(1);
    }
}
