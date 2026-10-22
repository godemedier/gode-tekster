//! Typerne, der går mellem enhederne og serveren (JSON over HTTPS).
//!
//! Serveren ejer revisionerne. Hver fil har en `rev`, der stiger med én pr. ændring, og hver
//! ændring får et løbenummer `seq`, der stiger på tværs af alle filer. En enhed spørger efter
//! »alt efter seq N« og skriver kun oven på den revision, den kender (compare-and-swap).

use serde::{Deserialize, Serialize};

/// En fil, som serveren kender den.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    /// Normaliseret sti med den stavemåde, filen sidst fik.
    pub path: String,
    pub rev: u64,
    /// Indholdets hash. `None` er en gravsten: filen er slettet i denne revision.
    pub hash: Option<String>,
    pub size: u64,
    /// Den enhed, der lavede revisionen.
    pub device: String,
    pub seq: u64,
}

impl Entry {
    pub fn deleted(&self) -> bool {
        self.hash.is_none()
    }
}

/// Svar på `GET /v1/aendringer?siden=N`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Changes {
    pub entries: Vec<Entry>,
    /// Højeste løbenummer i svaret. Er `more` sand, spørges der igen herfra.
    pub seq: u64,
    pub more: bool,
}

/// `POST /v1/commit`: skriv `hash` (eller slet med `None`) oven på `base_rev`. `base_rev` 0 betyder
/// »filen findes ikke for mig«. Bloben skal være lagt op først.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Commit {
    pub path: String,
    pub base_rev: u64,
    pub hash: Option<String>,
    pub size: u64,
}

/// Svaret på en commit. `Conflict` bærer serverens aktuelle udgave, så enheden kan flette.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "lowercase")]
pub enum CommitResult {
    Ok { entry: Entry },
    Conflict { current: Option<Entry> },
}

/// En slettet fil i papirkurven (`GET /v1/papirkurv`). Den kan hentes tilbage med en commit af
/// `hash` oven på `rev` (gravstenen), så længe serveren har indholdet: 30 dage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Trashed {
    pub path: String,
    /// Gravstenens revision.
    pub rev: u64,
    /// Den enhed, der slettede filen.
    pub device: String,
    /// Sekunder siden 1970.
    pub deleted: i64,
    /// Indholdet fra før sletningen.
    pub hash: String,
    pub size: u64,
}

/// `POST /v1/enheder`: en ny enhed med en parringskode (eller ejerens nøgle).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewDevice {
    pub name: String,
    #[serde(default)]
    pub code: Option<String>,
}

/// Nøglen vises kun denne ene gang. Serveren gemmer kun dens hash.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceToken {
    pub id: String,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub owner: bool,
    pub created: i64,
    pub last_seen: Option<i64>,
}

/// En engangskode, som en ny enhed taster for at blive parret. Gælder i ti minutter.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingCode {
    pub code: String,
    pub expires: i64,
}

// --- deling (ADR-0060) ---------------------------------------------------------------------------
// En del af en tekst, delt med navngivne personer. Hver person får sit eget link og sin egen kopi,
// så to gæster aldrig kommer i konflikt med hinanden. `base` er delen, som den så ud ved deling.

/// Ny deling fra ejerens pc.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewShare {
    pub title: String,
    pub text: String,
    pub names: Vec<String>,
    /// Hvor mange dage linkene virker. Standard 30, højst 365.
    pub days: Option<u32>,
    /// Afsenderens navn (»Dit navn« i programmet), så modtageren kan se, hvem teksten er fra.
    #[serde(default)]
    pub from: Option<String>,
}

/// Et link til én person. `token` sendes kun, når linket laves.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareLink {
    pub id: String,
    pub name: String,
    pub rev: u64,
    pub updated: Option<i64>,
    pub last_seen: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    /// Personens udgave af delen. Kun med, når ejeren henter én deling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareInfo {
    pub id: String,
    pub title: String,
    pub created: i64,
    pub expires: i64,
    pub revoked: bool,
    pub links: Vec<ShareLink>,
    /// Delen, som den så ud ved deling. Kun med, når ejeren henter én deling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
}

/// Det, gæsten ser.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuestCopy {
    pub title: String,
    pub name: String,
    pub text: String,
    pub rev: u64,
    pub expires: i64,
    /// Afsenderens navn, når programmet sendte det med (fra 0.2.23).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Gæsten gemmer oven på den revision, gæsten kender.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GuestSave {
    pub base_rev: u64,
    pub text: String,
}
