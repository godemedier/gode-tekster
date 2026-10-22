//! Vejen til serveren. Motoren kender kun dette trait, så simulationstesten kan køre den mod et
//! lager i samme proces, og appen mod synk.godemedier.dk over HTTPS (`Http`).

use std::time::Duration;

use synk_kerne::protokol::{
    Changes, Commit, CommitResult, DeviceToken, NewShare, PairingCode, ShareInfo, Trashed,
};

pub trait Transport {
    fn changes(&self, since: u64) -> Result<Changes, String>;
    fn get_blob(&self, hash: &str) -> Result<Vec<u8>, String>;
    fn put_blob(&self, hash: &str, bytes: &[u8]) -> Result<(), String>;
    fn commit(&self, c: &Commit) -> Result<CommitResult, String>;
}

/// HTTPS med enhedens nøgle. Fejlene følger programmets sprog og siger, om det er nettet eller
/// serveren.
pub struct Http {
    base: String,
    token: String,
    agent: ureq::Agent,
}

impl Http {
    pub fn new(base: &str, token: &str) -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(60)))
            .http_status_as_error(false)
            .user_agent(concat!("GodeTekster/", env!("CARGO_PKG_VERSION")))
            .tls_config(crate::net::tls_config())
            .build()
            .into();
        Http {
            base: base.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
            agent,
        }
    }

    fn auth(&self) -> String {
        format!("Bearer {}", self.token)
    }

    /// Meld enheden til: med en parringskode fra en anden enhed, eller med ejerens nøgle
    /// (ADMIN_TOKEN i Coolify) for den første. Nøglen, der kommer tilbage, vises kun denne gang.
    pub fn register(
        base: &str,
        name: &str,
        code: Option<&str>,
        admin: Option<&str>,
    ) -> Result<DeviceToken, String> {
        let http = Http::new(base, admin.unwrap_or_default());
        let body = serde_json::json!({ "name": name, "code": code });
        let mut req = http.agent.post(format!("{}/v1/enheder", http.base));
        if admin.is_some() {
            req = req.header("Authorization", http.auth());
        }
        let mut r = req
            .header("Content-Type", "application/json")
            .send(body.to_string())
            .map_err(net)?;
        match r.status().as_u16() {
            201 => read_json(&mut r),
            s => Err(server_error(s, r)),
        }
    }

    /// Er enheden ejerens? Kun ejeren må se listen over enheder, så svaret er 200 eller 403.
    pub fn is_owner(&self) -> Result<bool, String> {
        let r = self
            .agent
            .get(format!("{}/v1/enheder", self.base))
            .header("Authorization", self.auth())
            .call()
            .map_err(net)?;
        match r.status().as_u16() {
            200 => Ok(true),
            403 => Ok(false),
            s => Err(server_error(s, r)),
        }
    }

    /// En engangskode til en ny enhed (kun ejerens enhed).
    pub fn pairing_code(&self) -> Result<PairingCode, String> {
        let mut r = self
            .agent
            .post(format!("{}/v1/parringskode", self.base))
            .header("Authorization", self.auth())
            .send_empty()
            .map_err(net)?;
        match r.status().as_u16() {
            200 => read_json(&mut r),
            s => Err(server_error(s, r)),
        }
    }

    /// Filer slettet inden for 30 dage, som stadig kan hentes tilbage (serverens papirkurv).
    pub fn trash(&self) -> Result<Vec<Trashed>, String> {
        let mut r = self
            .agent
            .get(format!("{}/v1/papirkurv", self.base))
            .header("Authorization", self.auth())
            .call()
            .map_err(net)?;
        match r.status().as_u16() {
            200 => read_json(&mut r),
            s => Err(server_error(s, r)),
        }
    }

    // --- delinger (ADR-0060) ----------------------------------------------------------------

    pub fn base(&self) -> &str {
        &self.base
    }

    /// En ny deling. Svaret har linkenes nøgler, som kun sendes denne ene gang.
    pub fn create_share(&self, s: &NewShare) -> Result<ShareInfo, String> {
        let body = serde_json::to_string(s).map_err(|e| e.to_string())?;
        let mut r = self
            .agent
            .post(format!("{}/v1/delinger", self.base))
            .header("Authorization", self.auth())
            .header("Content-Type", "application/json")
            .send(body)
            .map_err(net)?;
        match r.status().as_u16() {
            201 => read_json(&mut r),
            s => Err(server_error(s, r)),
        }
    }

    /// Delingerne uden tekster.
    pub fn shares(&self) -> Result<Vec<ShareInfo>, String> {
        let mut r = self
            .agent
            .get(format!("{}/v1/delinger", self.base))
            .header("Authorization", self.auth())
            .call()
            .map_err(net)?;
        match r.status().as_u16() {
            200 => read_json(&mut r),
            s => Err(server_error(s, r)),
        }
    }

    /// Én deling med basen og hver persons udgave.
    pub fn share(&self, id: &str) -> Result<ShareInfo, String> {
        let mut r = self
            .agent
            .get(format!("{}/v1/delinger/{id}", self.base))
            .header("Authorization", self.auth())
            .call()
            .map_err(net)?;
        match r.status().as_u16() {
            200 => read_json(&mut r),
            s => Err(server_error(s, r)),
        }
    }

    /// Slå denne enhed fra på serveren (»Kobl fra«).
    pub fn revoke_self(&self) -> Result<(), String> {
        let r = self
            .agent
            .delete(format!("{}/v1/enheder/mig", self.base))
            .header("Authorization", self.auth())
            .call()
            .map_err(net)?;
        match r.status().as_u16() {
            204 => Ok(()),
            s => Err(server_error(s, r)),
        }
    }

    /// Stop (`stop`) eller slet (`slet`) en deling.
    pub fn end_share(&self, id: &str, delete: bool) -> Result<(), String> {
        let req = if delete {
            self.agent
                .delete(format!("{}/v1/delinger/{id}", self.base))
                .header("Authorization", self.auth())
                .call()
        } else {
            self.agent
                .post(format!("{}/v1/delinger/{id}/stop", self.base))
                .header("Authorization", self.auth())
                .send_empty()
        };
        let r = req.map_err(net)?;
        match r.status().as_u16() {
            204 => Ok(()),
            s => Err(server_error(s, r)),
        }
    }

    /// »Der er nyt«: kalder `on_seq` med hvert løbenummer, serveren melder, til forbindelsen
    /// lukker, eller `on_seq` svarer nej.
    pub fn listen(&self, mut on_seq: impl FnMut(u64) -> bool) -> Result<(), String> {
        use std::io::BufRead;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(20)))
            .http_status_as_error(false)
            .tls_config(crate::net::tls_config())
            .build()
            .into();
        let r = agent
            .get(format!("{}/v1/lyt", self.base))
            .header("Authorization", self.auth())
            .header("Accept", "text/event-stream")
            .call()
            .map_err(net)?;
        let status = r.status().as_u16();
        if status != 200 {
            return Err(server_error(status, r));
        }
        let reader = std::io::BufReader::new(r.into_body().into_reader());
        for line in reader.lines() {
            let line = line.map_err(net)?;
            if let Some(n) = line
                .strip_prefix("data:")
                .and_then(|d| d.trim().parse().ok())
            {
                if !on_seq(n) {
                    return Ok(());
                }
            }
        }
        Ok(())
    }
}

/// Nettet svigtede, før eller mens serveren svarede.
fn net(e: impl std::fmt::Display) -> String {
    t!(
        format!("Ingen forbindelse til synkroniseringsserveren: {e}"),
        format!("No connection to the sync server: {e}")
    )
}

fn read_json<T: serde::de::DeserializeOwned>(
    r: &mut ureq::http::Response<ureq::Body>,
) -> Result<T, String> {
    let text = r.body_mut().read_to_string().map_err(net)?;
    serde_json::from_str(&text).map_err(|e| {
        t!(
            format!("Uventet svar fra synkroniseringsserveren: {e}"),
            format!("Unexpected answer from the sync server: {e}")
        )
    })
}

/// Serverens fejlbesked, hvis der er en. Serveren skriver dansk.
fn server_error(status: u16, mut r: ureq::http::Response<ureq::Body>) -> String {
    let msg = read_json::<serde_json::Value>(&mut r)
        .ok()
        .and_then(|v| v.get("fejl").and_then(|f| f.as_str()).map(str::to_owned));
    match (status, msg) {
        (401, _) => t!(
            "Synkroniseringsserveren kender ikke denne enhed længere. Forbind igen.",
            "The sync server no longer knows this device. Connect again."
        )
        .to_owned(),
        (_, Some(m)) => t!(
            format!("Synkroniseringsserveren: {m}"),
            format!("The sync server: {m}")
        ),
        (s, None) => t!(
            format!("Synkroniseringsserveren svarede {s}."),
            format!("The sync server answered {s}.")
        ),
    }
}

impl Transport for Http {
    fn changes(&self, since: u64) -> Result<Changes, String> {
        let mut r = self
            .agent
            .get(format!("{}/v1/aendringer?siden={since}", self.base))
            .header("Authorization", self.auth())
            .call()
            .map_err(net)?;
        match r.status().as_u16() {
            200 => read_json(&mut r),
            s => Err(server_error(s, r)),
        }
    }

    fn get_blob(&self, hash: &str) -> Result<Vec<u8>, String> {
        let mut r = self
            .agent
            .get(format!("{}/v1/blob/{hash}", self.base))
            .header("Authorization", self.auth())
            .call()
            .map_err(net)?;
        match r.status().as_u16() {
            200 => {
                let bytes = r
                    .body_mut()
                    .with_config()
                    .limit(synk_kerne::MAX_SIZE)
                    .read_to_vec()
                    .map_err(net)?;
                // Indholdet efterprøves her også: en fejl på vejen må aldrig blive til en fil.
                if synk_kerne::hash(&bytes) != hash {
                    return Err(t!(
                        "Indholdet fra synkroniseringsserveren passede ikke til sin hash.",
                        "The content from the sync server did not match its hash."
                    )
                    .to_owned());
                }
                Ok(bytes)
            }
            s => Err(server_error(s, r)),
        }
    }

    fn put_blob(&self, hash: &str, bytes: &[u8]) -> Result<(), String> {
        let r = self
            .agent
            .put(format!("{}/v1/blob/{hash}", self.base))
            .header("Authorization", self.auth())
            .header("Content-Type", "application/octet-stream")
            .send(bytes)
            .map_err(net)?;
        match r.status().as_u16() {
            204 => Ok(()),
            s => Err(server_error(s, r)),
        }
    }

    fn commit(&self, c: &Commit) -> Result<CommitResult, String> {
        let mut r = self
            .agent
            .post(format!("{}/v1/commit", self.base))
            .header("Authorization", self.auth())
            .header("Content-Type", "application/json")
            .send(serde_json::to_vec(c).map_err(|e| e.to_string())?)
            .map_err(net)?;
        match r.status().as_u16() {
            200 | 409 => read_json(&mut r),
            s => Err(server_error(s, r)),
        }
    }
}
