//! Synkroniseringen af Dokumenter via egen server (ADR-0054). Kernen (stiregler, filter,
//! protokol, beslutningstabel) ligger i `synk/kerne` og deles med serveren.
//!
//! - [`state`]: enhedens hukommelse (basen pr. fil, serverens udgave, hash-cache).
//! - [`transport`]: vejen til serveren.
//! - [`engine`]: én synkrunde.
//! - [`service`]: synken i baggrunden og kommandoerne til fladen.

pub mod engine;
pub mod service;
pub mod state;
pub mod transport;

#[cfg(test)]
mod sim;
