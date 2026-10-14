//! Vejen til serveren. Motoren kender kun dette trait, så simulationstesten kan køre den mod et
//! lager i samme proces, og appen mod synk.godemedier.dk over HTTPS (`Http`).

use std::time::Duration;

use synk_kerne::protokol::{Changes, Commit, CommitResult, DeviceToken, PairingCode};

pub trait Transport {
    fn changes(&self, since: u64) -> Result<Changes, String>;
    fn get_blob(&self, hash: &str) -> Result<Vec<u8>, String>;
    fn put_blob(&self, hash: &str, bytes: &[u8]) -> Result<(), String>;
    fn commit(&self, c: &Commit) -> Result<CommitResult, String>;
}

/// HTTPS med enhedens nøgle. Fejlene er danske og siger, om det er nettet eller serveren.
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
            let line = line.map_err(|e| format!("Ingen forbindelse til synkserveren: {e}"))?;
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

fn net(e: ureq::Error) -> String {
    format!("Ingen forbindelse til synkserveren: {e}")
}

fn read_json<T: serde::de::DeserializeOwned>(
    r: &mut ureq::http::Response<ureq::Body>,
) -> Result<T, String> {
    let text = r.body_mut().read_to_string().map_err(net)?;
    serde_json::from_str(&text).map_err(|e| format!("Uventet svar fra synkserveren: {e}"))
}

/// Serverens danske fejlbesked, hvis der er en.
fn server_error(status: u16, mut r: ureq::http::Response<ureq::Body>) -> String {
    let msg = read_json::<serde_json::Value>(&mut r)
        .ok()
        .and_then(|v| v.get("fejl").and_then(|f| f.as_str()).map(str::to_owned));
    match (status, msg) {
        (401, _) => "Synkserveren kender ikke denne enhed længere. Forbind igen.".into(),
        (_, Some(m)) => format!("Synkserveren: {m}"),
        (s, None) => format!("Synkserveren svarede {s}."),
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
                    return Err("Indholdet fra synkserveren passede ikke til sin hash.".into());
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
