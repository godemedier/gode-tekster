//! Ruterne. Hver rute uden for `/api/health` kræver en enheds nøgle (`Authorization: Bearer …`),
//! undtagen oprettelsen af en enhed, der kræver ejerens ADMIN_TOKEN eller en parringskode.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use synk_kerne::protokol::{Commit, CommitResult, DeviceInfo, NewDevice};
use synk_kerne::store::{Store, StoreError};
use synk_kerne::MAX_SIZE;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

/// Forkerte parringskoder, før serveren holder pause med at tage imod flere.
const MAX_PAIRING_FAILURES: u32 = 10;
const PAIRING_WINDOW: Duration = Duration::from_secs(600);

pub struct App {
    store: Arc<Store>,
    admin: Option<String>,
    tx: broadcast::Sender<u64>,
    pairing_failures: Mutex<(Instant, u32)>,
}

impl App {
    pub fn new(store: Arc<Store>, admin: Option<String>) -> Result<Self, StoreError> {
        let (tx, _) = broadcast::channel(64);
        Ok(App {
            store,
            admin,
            tx,
            pairing_failures: Mutex::new((Instant::now(), 0)),
        })
    }
}

type Shared = Arc<App>;

pub fn router(app: App) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/v1/enheder", post(add_device).get(list_devices))
        .route("/v1/enheder/{id}", delete(revoke))
        .route("/v1/parringskode", post(pairing_code))
        .route("/v1/aendringer", get(changes))
        .route("/v1/fil", get(file))
        .route("/v1/historik", get(history))
        .route("/v1/papirkurv", get(trash))
        .route("/v1/blob/{hash}", get(get_blob).put(put_blob))
        .route("/v1/commit", post(commit))
        .route("/v1/lyt", get(listen))
        .layer(DefaultBodyLimit::max(MAX_SIZE as usize + 64 * 1024))
        .with_state(Arc::new(app))
}

/// En fejl med en dansk besked til appen.
pub struct Fejl(StatusCode, String);

impl IntoResponse for Fejl {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "fejl": self.1 }))).into_response()
    }
}

impl From<StoreError> for Fejl {
    fn from(e: StoreError) -> Self {
        let status = match &e {
            StoreError::BadPath(_) | StoreError::BadHash | StoreError::MissingBlob => {
                StatusCode::BAD_REQUEST
            }
            StoreError::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            StoreError::Db(_) | StoreError::Io(_) => {
                eprintln!("lagerfejl: {e}");
                return Fejl(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Serveren kunne ikke gemme. Intet er ændret.".into(),
                );
            }
        };
        Fejl(status, e.to_string())
    }
}

/// SQLite og blobs er blokerende: kør dem uden for de asynkrone tråde.
async fn blocking<T, F>(f: F) -> Result<T, Fejl>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, StoreError> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| Fejl(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .map_err(Fejl::from)
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
}

/// Sammenligning, der tager lige lang tid, uanset hvor tidligt to nøgler er forskellige.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

async fn device(app: &Shared, headers: &HeaderMap) -> Result<DeviceInfo, Fejl> {
    let token = bearer(headers)
        .ok_or_else(|| Fejl(StatusCode::UNAUTHORIZED, "Enhedens nøgle mangler.".into()))?
        .to_owned();
    let store = app.store.clone();
    blocking(move || store.device_by_token(&token))
        .await?
        .ok_or_else(|| {
            Fejl(
                StatusCode::UNAUTHORIZED,
                "Nøglen er ukendt eller slået fra.".into(),
            )
        })
}

async fn owner(app: &Shared, headers: &HeaderMap) -> Result<DeviceInfo, Fejl> {
    let d = device(app, headers).await?;
    if d.owner {
        Ok(d)
    } else {
        Err(Fejl(
            StatusCode::FORBIDDEN,
            "Kun ejerens enhed kan det.".into(),
        ))
    }
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({
        "ok": true,
        "tjeneste": "synk",
        "commit": std::env::var("SOURCE_COMMIT").unwrap_or_default(),
    }))
}

async fn add_device(
    State(app): State<Shared>,
    headers: HeaderMap,
    Json(body): Json<NewDevice>,
) -> Result<impl IntoResponse, Fejl> {
    let is_admin = match (&app.admin, bearer(&headers)) {
        (Some(admin), Some(t)) => same(admin, t),
        _ => false,
    };
    if !is_admin {
        let Some(code) = body.code.clone() else {
            return Err(Fejl(
                StatusCode::UNAUTHORIZED,
                "Tast parringskoden fra en anden enhed.".into(),
            ));
        };
        {
            let mut f = app
                .pairing_failures
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if f.0.elapsed() > PAIRING_WINDOW {
                *f = (Instant::now(), 0);
            }
            if f.1 >= MAX_PAIRING_FAILURES {
                return Err(Fejl(
                    StatusCode::TOO_MANY_REQUESTS,
                    "For mange forkerte koder. Prøv igen om ti minutter.".into(),
                ));
            }
        }
        let store = app.store.clone();
        if !blocking(move || store.use_pairing_code(&code)).await? {
            let mut f = app
                .pairing_failures
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            f.1 += 1;
            return Err(Fejl(
                StatusCode::FORBIDDEN,
                "Koden er forkert eller udløbet.".into(),
            ));
        }
    }
    let name = if body.name.trim().is_empty() {
        "Enhed".to_owned()
    } else {
        body.name
    };
    let store = app.store.clone();
    let token = blocking(move || store.add_device(&name, is_admin)).await?;
    Ok((StatusCode::CREATED, Json(token)))
}

async fn list_devices(
    State(app): State<Shared>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, Fejl> {
    owner(&app, &headers).await?;
    let store = app.store.clone();
    Ok(Json(blocking(move || store.devices()).await?))
}

async fn revoke(
    State(app): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, Fejl> {
    let me = owner(&app, &headers).await?;
    if me.id == id {
        return Err(Fejl(
            StatusCode::BAD_REQUEST,
            "Ejerens enhed kan ikke slå sig selv fra.".into(),
        ));
    }
    let store = app.store.clone();
    if blocking(move || store.revoke(&id)).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(Fejl(StatusCode::NOT_FOUND, "Enheden findes ikke.".into()))
    }
}

async fn pairing_code(
    State(app): State<Shared>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, Fejl> {
    owner(&app, &headers).await?;
    let store = app.store.clone();
    Ok(Json(blocking(move || store.new_pairing_code()).await?))
}

#[derive(Deserialize)]
struct Since {
    siden: Option<u64>,
    antal: Option<usize>,
}

async fn changes(
    State(app): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<Since>,
) -> Result<impl IntoResponse, Fejl> {
    device(&app, &headers).await?;
    let store = app.store.clone();
    let limit = q.antal.unwrap_or(1000).clamp(1, 5000);
    Ok(Json(
        blocking(move || store.changes(q.siden.unwrap_or(0), limit)).await?,
    ))
}

#[derive(Deserialize)]
struct PathQuery {
    sti: String,
}

async fn file(
    State(app): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Result<impl IntoResponse, Fejl> {
    device(&app, &headers).await?;
    let store = app.store.clone();
    match blocking(move || store.get(&q.sti)).await? {
        Some(e) => Ok(Json(e)),
        None => Err(Fejl(StatusCode::NOT_FOUND, "Filen findes ikke.".into())),
    }
}

async fn history(
    State(app): State<Shared>,
    headers: HeaderMap,
    Query(q): Query<PathQuery>,
) -> Result<impl IntoResponse, Fejl> {
    device(&app, &headers).await?;
    let store = app.store.clone();
    Ok(Json(blocking(move || store.history(&q.sti)).await?))
}

async fn trash(State(app): State<Shared>, headers: HeaderMap) -> Result<impl IntoResponse, Fejl> {
    device(&app, &headers).await?;
    let store = app.store.clone();
    Ok(Json(blocking(move || store.trash()).await?))
}

async fn get_blob(
    State(app): State<Shared>,
    headers: HeaderMap,
    Path(hash): Path<String>,
) -> Result<Response, Fejl> {
    device(&app, &headers).await?;
    let store = app.store.clone();
    match blocking(move || store.get_blob(&hash)).await? {
        Some(bytes) => {
            Ok(([(header::CONTENT_TYPE, "application/octet-stream")], bytes).into_response())
        }
        None => Err(Fejl(StatusCode::NOT_FOUND, "Indholdet findes ikke.".into())),
    }
}

async fn put_blob(
    State(app): State<Shared>,
    headers: HeaderMap,
    Path(hash): Path<String>,
    body: Bytes,
) -> Result<impl IntoResponse, Fejl> {
    device(&app, &headers).await?;
    let store = app.store.clone();
    blocking(move || store.put_blob(&hash, &body)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn commit(
    State(app): State<Shared>,
    headers: HeaderMap,
    Json(c): Json<Commit>,
) -> Result<Response, Fejl> {
    let me = device(&app, &headers).await?;
    let store = app.store.clone();
    let result = blocking(move || store.commit(&c, &me.name)).await?;
    Ok(match result {
        CommitResult::Ok { ref entry } => {
            // Ingen lyttere er ikke en fejl.
            let _ = app.tx.send(entry.seq);
            (StatusCode::OK, Json(result)).into_response()
        }
        CommitResult::Conflict { .. } => (StatusCode::CONFLICT, Json(result)).into_response(),
    })
}

/// »Der er nyt«: det aktuelle løbenummer med det samme og igen ved hver ændring. Enheden henter
/// selv ændringerne, så en tabt besked aldrig koster andet end ventetid.
async fn listen(
    State(app): State<Shared>,
    headers: HeaderMap,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>, Fejl> {
    device(&app, &headers).await?;
    let store = app.store.clone();
    let now = blocking(move || store.seq()).await?;
    let first = tokio_stream::once(now);
    let rest = BroadcastStream::new(app.tx.subscribe()).filter_map(|r| r.ok());
    let stream = first
        .chain(rest)
        .map(|seq| Ok(Event::default().event("seq").data(seq.to_string())));
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(20))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use synk_kerne::protokol::{Changes, DeviceToken, Entry, PairingCode, Trashed};

    const ADMIN: &str = "en-lang-hemmelig-ejernoegle-til-test-0123456789";

    struct Server {
        base: String,
        _dir: tempfile::TempDir,
    }

    fn start() -> Server {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let store = Arc::new(Store::open(dir.path()).unwrap_or_else(|e| panic!("{e}")));
        let app = App::new(store, Some(ADMIN.into())).unwrap_or_else(|e| panic!("{e}"));
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().unwrap_or_else(|e| panic!("{e}"));
            rt.block_on(async move {
                let l = tokio::net::TcpListener::bind("127.0.0.1:0")
                    .await
                    .unwrap_or_else(|e| panic!("{e}"));
                let _ = tx.send(l.local_addr().map(|a| a.port()).unwrap_or(0));
                let _ = axum::serve(l, router(app)).await;
            });
        });
        let port = rx.recv().unwrap_or_else(|e| panic!("{e}"));
        Server {
            base: format!("http://127.0.0.1:{port}"),
            _dir: dir,
        }
    }

    fn agent() -> ureq::Agent {
        ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build()
            .into()
    }

    fn json<T: serde::de::DeserializeOwned>(mut r: ureq::http::Response<ureq::Body>) -> T {
        r.body_mut().read_json().unwrap_or_else(|e| panic!("{e}"))
    }

    fn register(s: &Server, a: &ureq::Agent) -> DeviceToken {
        let r = a
            .post(format!("{}/v1/enheder", s.base))
            .header("Authorization", format!("Bearer {ADMIN}"))
            .send_json(json!({ "name": "Pc" }))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 201);
        json(r)
    }

    #[test]
    fn hele_vejen_rundt() {
        let s = start();
        let a = agent();
        let pc = register(&s, &a);
        let auth = format!("Bearer {}", pc.token);

        // Uden nøgle: nej.
        let r = a
            .get(format!("{}/v1/aendringer", s.base))
            .call()
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 401);

        // Læg indhold op med forkert hash: nej.
        let text = "Kapitel 1\n\nDet var en mørk aften.\n";
        let h = synk_kerne::hash(text.as_bytes());
        let r = a
            .put(format!("{}/v1/blob/{}", s.base, synk_kerne::hash(b"andet")))
            .header("Authorization", &auth)
            .send(text)
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 400);
        let r = a
            .put(format!("{}/v1/blob/{h}", s.base))
            .header("Authorization", &auth)
            .send(text)
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 204);

        let commit = |base: u64| {
            a.post(format!("{}/v1/commit", s.base))
                .header("Authorization", &auth)
                .send_json(json!({ "path": "Skriv/Kapitel 1.md", "base_rev": base, "hash": h, "size": text.len() }))
                .unwrap_or_else(|e| panic!("{e}"))
        };
        let r = commit(0);
        assert_eq!(r.status(), 200);
        let r = a
            .post(format!("{}/v1/commit", s.base))
            .header("Authorization", &auth)
            .send_json(
                json!({ "path": "skriv/kapitel 1.md", "base_rev": 0, "hash": null, "size": 0 }),
            )
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(
            r.status(),
            409,
            "en enhed, der ikke kender filen, må ikke slette den"
        );

        let c: Changes = json(
            a.get(format!("{}/v1/aendringer?siden=0", s.base))
                .header("Authorization", &auth)
                .call()
                .unwrap_or_else(|e| panic!("{e}")),
        );
        assert_eq!(c.entries.len(), 1);
        assert_eq!(c.entries[0].device, "Pc");

        let mut r = a
            .get(format!("{}/v1/blob/{h}", s.base))
            .header("Authorization", &auth)
            .call()
            .unwrap_or_else(|e| panic!("{e}"));
        let got = r
            .body_mut()
            .read_to_string()
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(got, text);

        let e: Entry = json(
            a.get(format!("{}/v1/fil?sti=Skriv%2FKapitel%201.md", s.base))
                .header("Authorization", &auth)
                .call()
                .unwrap_or_else(|e| panic!("{e}")),
        );
        assert_eq!(e.rev, 1);
    }

    #[test]
    fn parring_af_telefonen() {
        let s = start();
        let a = agent();
        let pc = register(&s, &a);
        // Uden kode og uden ejernøgle: nej.
        let r = a
            .post(format!("{}/v1/enheder", s.base))
            .send_json(json!({ "name": "Telefon" }))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 401);
        let code: PairingCode = json(
            a.post(format!("{}/v1/parringskode", s.base))
                .header("Authorization", format!("Bearer {}", pc.token))
                .send_empty()
                .unwrap_or_else(|e| panic!("{e}")),
        );
        let r = a
            .post(format!("{}/v1/enheder", s.base))
            .send_json(json!({ "name": "Telefon", "code": code.code }))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 201);
        let phone: DeviceToken = json(r);
        // Telefonen er ikke ejer og kan ikke lave koder.
        let r = a
            .post(format!("{}/v1/parringskode", s.base))
            .header("Authorization", format!("Bearer {}", phone.token))
            .send_empty()
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 403);
        // Ejeren slår telefonen fra, og så virker dens nøgle ikke mere.
        let r = a
            .delete(format!("{}/v1/enheder/{}", s.base, phone.id))
            .header("Authorization", format!("Bearer {}", pc.token))
            .call()
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 204);
        let r = a
            .get(format!("{}/v1/aendringer", s.base))
            .header("Authorization", format!("Bearer {}", phone.token))
            .call()
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 401);
    }

    #[test]
    fn forkerte_koder_bremses() {
        let s = start();
        let a = agent();
        let mut last = 0;
        for _ in 0..=MAX_PAIRING_FAILURES {
            last = a
                .post(format!("{}/v1/enheder", s.base))
                .send_json(json!({ "name": "x", "code": "AAAA-AAAA" }))
                .map(|r| r.status().as_u16())
                .unwrap_or(0);
        }
        assert_eq!(last, 429);
    }

    #[test]
    fn noegler_sammenlignes_helt() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
    }

    #[test]
    fn papirkurven_over_nettet() {
        let s = start();
        let a = agent();
        let pc = register(&s, &a);
        let auth = format!("Bearer {}", pc.token);
        let text = "Udkast
";
        let h = synk_kerne::hash(text.as_bytes());
        a.put(format!("{}/v1/blob/{h}", s.base))
            .header("Authorization", &auth)
            .send(text)
            .unwrap_or_else(|e| panic!("{e}"));
        for (base, hash) in [(0, Some(h.as_str())), (1, None)] {
            let r = a
                .post(format!("{}/v1/commit", s.base))
                .header("Authorization", &auth)
                .send_json(json!({ "path": "Noter/Udkast.md", "base_rev": base, "hash": hash, "size": text.len() }))
                .unwrap_or_else(|e| panic!("{e}"));
            assert_eq!(r.status(), 200);
        }
        let r = a
            .get(format!("{}/v1/papirkurv", s.base))
            .call()
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 401);
        let t: Vec<Trashed> = json(
            a.get(format!("{}/v1/papirkurv", s.base))
                .header("Authorization", &auth)
                .call()
                .unwrap_or_else(|e| panic!("{e}")),
        );
        assert_eq!(t.len(), 1);
        assert_eq!(
            (
                t[0].path.as_str(),
                t[0].rev,
                t[0].hash.as_str(),
                t[0].device.as_str()
            ),
            ("Noter/Udkast.md", 2, h.as_str(), "Pc")
        );
    }
}
