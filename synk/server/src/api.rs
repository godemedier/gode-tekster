//! Ruterne. Hver rute uden for `/api/health` kræver en enheds nøgle (`Authorization: Bearer …`),
//! undtagen oprettelsen af en enhed, der kræver ejerens ADMIN_TOKEN eller en parringskode.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

use synk_kerne::deling::{GuestSaved, MAX_SHARE};
use synk_kerne::protokol::{Commit, CommitResult, DeviceInfo, GuestSave, NewDevice, NewShare};
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
    /// Forkerte parringskoder pr. adresse. Én fælles tæller lod enhver spærre for alle (20/10).
    pairing_failures: Mutex<HashMap<String, (Instant, u32)>>,
    /// Ukendte delingslinks pr. adresse, så ingen kan prøve sig frem i stor stil.
    guest_failures: Mutex<HashMap<String, (Instant, u32)>>,
}

impl App {
    pub fn new(store: Arc<Store>, admin: Option<String>) -> Result<Self, StoreError> {
        let (tx, _) = broadcast::channel(64);
        Ok(App {
            store,
            admin,
            tx,
            pairing_failures: Mutex::new(HashMap::new()),
            guest_failures: Mutex::new(HashMap::new()),
        })
    }
}

type Shared = Arc<App>;

/// En ejer, der ikke er set så længe, regnes for væk (ejernøglen virker igen).
const OWNER_GONE_SECS: i64 = 30 * 24 * 3600;

fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Små forespørgsler (enheder, commit, koder). Indhold og delinger har deres eget loft.
const SMALL_BODY: usize = 64 * 1024;
/// En deling som JSON: teksten kan fylde mere, når tegn escapes.
const SHARE_BODY: usize = 2 * MAX_SHARE + 64 * 1024;

pub fn router(app: App) -> Router {
    let shared: Shared = Arc::new(app);
    Router::new()
        .route("/api/health", get(health))
        .route("/v1/enheder", post(add_device).get(list_devices))
        .route("/v1/enheder/{id}", delete(revoke))
        .route("/v1/parringskode", post(pairing_code))
        .route("/v1/aendringer", get(changes))
        .route("/v1/fil", get(file))
        .route("/v1/historik", get(history))
        .route("/v1/papirkurv", get(trash))
        .route(
            "/v1/blob/{hash}",
            get(get_blob)
                .put(put_blob)
                .layer(DefaultBodyLimit::max(MAX_SIZE as usize + 64 * 1024)),
        )
        .route("/v1/commit", post(commit))
        .route("/v1/lyt", get(listen))
        .route(
            "/v1/delinger",
            post(create_share)
                .get(list_shares)
                .layer(DefaultBodyLimit::max(SHARE_BODY)),
        )
        .route("/v1/delinger/{id}", get(get_share).delete(delete_share))
        .route("/v1/delinger/{id}/stop", post(stop_share))
        .route(
            "/v1/gaest/{token}",
            get(guest_get)
                .put(guest_put)
                .layer(DefaultBodyLimit::max(SHARE_BODY)),
        )
        .route_layer(middleware::from_fn_with_state(shared.clone(), gate))
        .layer(DefaultBodyLimit::max(SMALL_BODY))
        .with_state(shared)
}

/// Før indholdet læses: en enheds nøgle på enhedernes ruter, og en adresse, der ikke er spærret, på
/// gæsternes. Før læste serveren op til 20 MB fra hvem som helst og tjekkede først bagefter
/// (kodegennemgang 20/10). Handlerne tjekker stadig selv, hvem det er.
async fn gate(State(app): State<Shared>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let open = path == "/api/health" || (path == "/v1/enheder" && req.method() == Method::POST);
    if path.starts_with("/v1/gaest/") {
        if guest_blocked(&app, &client(req.headers()), false) {
            return too_many().into_response();
        }
    } else if !open {
        if let Err(e) = device(&app, req.headers()).await {
            return e.into_response();
        }
    }
    next.run(req).await
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
            StoreError::Invalid(_) => StatusCode::BAD_REQUEST,
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
    let admin_token = match (&app.admin, bearer(&headers)) {
        (Some(admin), Some(t)) => same(admin, t),
        _ => false,
    };
    // Ejernøglen er kun til den første enhed. Findes der en ejer, parres resten med en kode, så en
    // lækket nøgle ikke giver adgang til alt (kodegennemgang 20/10). Er alle ejere slået fra, virker
    // den igen.
    // En ejer, der ikke er set i 30 dage (ny pc, geninstalleret uden »Kobl fra«), låser ikke ejeren
    // ude: så virker nøglen igen (evaluering af runde B, 20/10).
    let is_admin = admin_token && {
        let store = app.store.clone();
        let cutoff = unix_now() - OWNER_GONE_SECS;
        !blocking(move || store.devices())
            .await?
            .iter()
            .any(|d| d.owner && d.last_seen.unwrap_or(d.created) > cutoff)
    };
    if admin_token && !is_admin {
        return Err(Fejl(
            StatusCode::FORBIDDEN,
            "Der er allerede en ejer. Par den nye enhed med en kode fra ejerens enhed.".into(),
        ));
    }
    if !is_admin {
        let Some(code) = body.code.clone() else {
            return Err(Fejl(
                StatusCode::UNAUTHORIZED,
                "Tast parringskoden fra en anden enhed.".into(),
            ));
        };
        let who = client(&headers);
        if counted(&app.pairing_failures, &who, false) >= MAX_PAIRING_FAILURES {
            return Err(Fejl(
                StatusCode::TOO_MANY_REQUESTS,
                "For mange forkerte koder. Prøv igen om ti minutter.".into(),
            ));
        }
        let store = app.store.clone();
        if !blocking(move || store.use_pairing_code(&code)).await? {
            counted(&app.pairing_failures, &who, true);
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

/// Slå en enhed fra. Ejeren kan slå alle fra; enhver enhed kan slå sig selv fra (`mig`), så »Kobl fra«
/// i appen også gælder på serveren. Er den sidste ejer slået fra, virker ejernøglen igen.
async fn revoke(
    State(app): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, Fejl> {
    let me = device(&app, &headers).await?;
    let id = if id == "mig" { me.id.clone() } else { id };
    if id != me.id && !me.owner {
        return Err(Fejl(
            StatusCode::FORBIDDEN,
            "Kun ejerens enhed kan det.".into(),
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

// --- delinger (ADR-0060) -----------------------------------------------------------------------

async fn create_share(
    State(app): State<Shared>,
    headers: HeaderMap,
    Json(s): Json<NewShare>,
) -> Result<impl IntoResponse, Fejl> {
    owner(&app, &headers).await?;
    let store = app.store.clone();
    let share = blocking(move || store.create_share(&s)).await?;
    Ok((StatusCode::CREATED, Json(share)))
}

async fn list_shares(
    State(app): State<Shared>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, Fejl> {
    owner(&app, &headers).await?;
    let store = app.store.clone();
    Ok(Json(blocking(move || store.shares()).await?))
}

async fn get_share(
    State(app): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, Fejl> {
    owner(&app, &headers).await?;
    let store = app.store.clone();
    blocking(move || store.share(&id))
        .await?
        .map(Json)
        .ok_or_else(|| Fejl(StatusCode::NOT_FOUND, "Delingen findes ikke.".into()))
}

async fn stop_share(
    State(app): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, Fejl> {
    owner(&app, &headers).await?;
    let store = app.store.clone();
    blocking(move || store.revoke_share(&id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_share(
    State(app): State<Shared>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<impl IntoResponse, Fejl> {
    owner(&app, &headers).await?;
    let store = app.store.clone();
    blocking(move || store.delete_share(&id)).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Gæstens svar må ikke gemmes i en cache, sendes videre som henviser eller indekseres.
fn guest_headers(mut r: Response) -> Response {
    let h = r.headers_mut();
    h.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    h.insert(
        header::REFERRER_POLICY,
        header::HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        "x-robots-tag",
        header::HeaderValue::from_static("noindex, nofollow"),
    );
    r
}

/// Adressen bag Coolifys proxy. Proxyen lægger den adresse, den selv så, sidst i
/// `X-Forwarded-For`. Det første led kan klienten selv skrive (kodegennemgang 20/10). En IPv6-adresse
/// tælles som sit /64-net, for én kunde har typisk et helt /64 og kunne ellers skifte adresse for hvert
/// forsøg (gennemgang 22/10).
fn client(headers: &HeaderMap) -> String {
    let raw = headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.rsplit(',').next())
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "ukendt".into());
    match raw.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V6(v6)) if v6.to_ipv4_mapped().is_none() => {
            let s = v6.segments();
            format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
        }
        _ => raw,
    }
}

const MAX_GUEST_FAILURES: u32 = 20;
/// Flere adresser end det i en tæller: de udløbne ryddes først. Er der stadig for mange, spærres nye
/// adresser, til de gamle udløber.
const MAX_TRACKED: usize = 10_000;

/// Forkerte forsøg fra en adresse inden for de sidste ti minutter. Tæller et mere, når `failed`.
/// En forgiftet lås tæller som spærret (fail-closed).
fn counted(map: &Mutex<HashMap<String, (Instant, u32)>>, who: &str, failed: bool) -> u32 {
    let Ok(mut map) = map.lock() else {
        return u32::MAX;
    };
    if map.len() > MAX_TRACKED {
        map.retain(|_, (since, _)| since.elapsed() <= PAIRING_WINDOW);
        // Før blev tælleren tømt, og så fik en angriber med mange adresser nye forsøg til alle
        // (gennemgang 22/10). Nu er det fail-closed for adresser, tælleren ikke kender.
        if map.len() > MAX_TRACKED && !map.contains_key(who) {
            return u32::MAX;
        }
    }
    let entry = map.entry(who.to_owned()).or_insert((Instant::now(), 0));
    if entry.0.elapsed() > PAIRING_WINDOW {
        *entry = (Instant::now(), 0);
    }
    if failed {
        entry.1 = entry.1.saturating_add(1);
    }
    entry.1
}

/// Har adressen prøvet for mange ukendte links? Tæller et forsøg mere, når `failed`.
fn guest_blocked(app: &Shared, who: &str, failed: bool) -> bool {
    counted(&app.guest_failures, who, failed) > MAX_GUEST_FAILURES
}

fn gone() -> Fejl {
    Fejl(
        StatusCode::NOT_FOUND,
        "Linket virker ikke. Det kan være udløbet, eller delingen er stoppet.".into(),
    )
}

fn too_many() -> Fejl {
    Fejl(
        StatusCode::TOO_MANY_REQUESTS,
        "For mange forkerte links. Prøv igen om lidt.".into(),
    )
}

async fn guest_get(
    State(app): State<Shared>,
    headers: HeaderMap,
    Path(token): Path<String>,
) -> Result<Response, Fejl> {
    let who = client(&headers);
    if guest_blocked(&app, &who, false) {
        return Err(too_many());
    }
    let store = app.store.clone();
    match blocking(move || store.guest_copy(&token)).await? {
        Some(copy) => Ok(guest_headers(Json(copy).into_response())),
        None => {
            guest_blocked(&app, &who, true);
            Err(gone())
        }
    }
}

async fn guest_put(
    State(app): State<Shared>,
    headers: HeaderMap,
    Path(token): Path<String>,
    Json(save): Json<GuestSave>,
) -> Result<Response, Fejl> {
    let who = client(&headers);
    if guest_blocked(&app, &who, false) {
        return Err(too_many());
    }
    let store = app.store.clone();
    let result = blocking(move || store.guest_save(&token, save.base_rev, &save.text)).await?;
    Ok(guest_headers(match result {
        GuestSaved::Saved(rev) => Json(json!({ "rev": rev })).into_response(),
        GuestSaved::Conflict { rev, text } => (
            StatusCode::CONFLICT,
            Json(json!({ "rev": rev, "text": text })),
        )
            .into_response(),
        GuestSaved::Gone => {
            guest_blocked(&app, &who, true);
            return Err(gone());
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use synk_kerne::protokol::{
        Changes, DeviceToken, Entry, GuestCopy, PairingCode, ShareInfo, Trashed,
    };

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

    /// Kodegennemgang 20/10: ejernøglen laver ikke flere ejere, når der er én.
    #[test]
    fn ejernoeglen_virker_kun_til_den_foerste_enhed() {
        let s = start();
        let a = agent();
        register(&s, &a);
        let r = a
            .post(format!("{}/v1/enheder", s.base))
            .header("Authorization", format!("Bearer {ADMIN}"))
            .send_json(json!({ "name": "Ny pc" }))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 403);
    }

    /// Kodegennemgang 20/10: indholdet læses først, når nøglen er kendt, og små ruter har et lille loft.
    #[test]
    fn ukendte_faar_ikke_lov_at_sende_store_forespoergsler() {
        let s = start();
        let a = agent();
        let pc = register(&s, &a);
        let big = "x".repeat(200 * 1024);
        let r = a
            .put(format!(
                "{}/v1/blob/{}",
                s.base,
                synk_kerne::hash(big.as_bytes())
            ))
            .send(big.as_str())
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 401, "uden nøgle afvises indhold før det læses");
        let r = a
            .post(format!("{}/v1/enheder", s.base))
            .send_json(json!({ "name": big, "code": "AAAA-AAAA" }))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 413, "oprettelsen af en enhed har et lille loft");
        // En enhed med nøgle kan stadig lægge en fil op, der er større end det lille loft.
        let r = a
            .put(format!(
                "{}/v1/blob/{}",
                s.base,
                synk_kerne::hash(big.as_bytes())
            ))
            .header("Authorization", format!("Bearer {}", pc.token))
            .send(big.as_str())
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 204);
    }

    /// Kodegennemgang 20/10: forkerte koder fra én adresse spærrer ikke for en anden.
    #[test]
    fn forkerte_koder_bremses_pr_adresse() {
        let s = start();
        let a = agent();
        for _ in 0..=MAX_PAIRING_FAILURES {
            let _ = a
                .post(format!("{}/v1/enheder", s.base))
                .header("X-Forwarded-For", "10.0.0.1")
                .send_json(json!({ "name": "x", "code": "AAAA-AAAA" }));
        }
        let r = a
            .post(format!("{}/v1/enheder", s.base))
            .header("X-Forwarded-For", "10.0.0.2")
            .send_json(json!({ "name": "x", "code": "AAAA-AAAA" }))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 403, "en anden adresse må stadig prøve");
    }

    #[test]
    fn klientens_adresse_er_proxyens_sidste_led() {
        let mut h = HeaderMap::new();
        h.insert(
            "x-forwarded-for",
            "1.2.3.4, 5.6.7.8".parse().unwrap_or_else(|e| panic!("{e}")),
        );
        assert_eq!(client(&h), "5.6.7.8");
    }

    #[test]
    fn ipv6_taelles_som_sit_net() {
        let mut h = HeaderMap::new();
        h.insert(
            "x-forwarded-for",
            "2001:db8:1:2:aaaa::1"
                .parse()
                .unwrap_or_else(|e| panic!("{e}")),
        );
        assert_eq!(client(&h), "2001:db8:1:2::/64");
    }

    #[test]
    fn en_fuld_taeller_spaerrer_nye_adresser() {
        let map = Mutex::new(HashMap::new());
        for i in 0..=MAX_TRACKED {
            counted(&map, &format!("10.0.{}.{}", i / 256, i % 256), true);
        }
        assert_eq!(counted(&map, "ny", false), u32::MAX, "fail-closed");
        assert_eq!(
            counted(&map, "10.0.0.0", true),
            2,
            "en kendt adresse tælles videre"
        );
    }

    /// Evaluering af runde B: ejeren slår sig selv fra (»Kobl fra«), og så virker ejernøglen igen.
    #[test]
    fn ejeren_kan_koble_fra_og_komme_ind_igen() {
        let s = start();
        let a = agent();
        let pc = register(&s, &a);
        let r = a
            .delete(format!("{}/v1/enheder/mig", s.base))
            .header("Authorization", format!("Bearer {}", pc.token))
            .call()
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 204);
        register(&s, &a);
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

    #[test]
    fn deling_hele_vejen_rundt() {
        let s = start();
        let a = agent();
        let pc = register(&s, &a);
        let auth = format!("Bearer {}", pc.token);
        let r = a
            .post(format!("{}/v1/delinger", s.base))
            .header("Authorization", &auth)
            .send_json(json!({ "title": "Kapitel 2", "text": "Et afsnit.", "names": ["Andreas"] }))
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 201);
        let share: ShareInfo = json(r);
        let token = share.links[0].token.clone().unwrap_or_default();
        let guest = format!("{}/v1/gaest/{token}", s.base);

        // Gæsten henter uden nøgle, og svaret må ikke gemmes eller indekseres.
        let r = a.get(&guest).call().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 200);
        assert_eq!(
            r.headers()
                .get("cache-control")
                .and_then(|v| v.to_str().ok()),
            Some("no-store")
        );
        let copy: GuestCopy = json(r);
        assert_eq!(
            (copy.name.as_str(), copy.text.as_str(), copy.rev),
            ("Andreas", "Et afsnit.", 1)
        );

        let put = |rev: u64, text: &str| {
            a.put(&guest)
                .send_json(json!({ "base_rev": rev, "text": text }))
                .unwrap_or_else(|e| panic!("{e}"))
        };
        assert_eq!(put(1, "Et {++kort ++}afsnit.").status(), 200);
        assert_eq!(put(1, "andet").status(), 409);

        // Ejeren ser udgaven. Uden nøgle: nej.
        let one = format!("{}/v1/delinger/{}", s.base, share.id);
        let r = a.get(&one).call().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 401);
        let r = a
            .get(&one)
            .header("Authorization", &auth)
            .call()
            .unwrap_or_else(|e| panic!("{e}"));
        let full: ShareInfo = json(r);
        assert_eq!(full.links[0].text.as_deref(), Some("Et {++kort ++}afsnit."));

        // Stop: linket virker ikke længere.
        let r = a
            .post(format!("{one}/stop"))
            .header("Authorization", &auth)
            .send_empty()
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 204);
        let r = a.get(&guest).call().unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(r.status(), 404);

        // Mange forkerte links fra samme adresse giver en pause.
        let mut last = 0;
        for i in 0..25 {
            last = a
                .get(format!("{}/v1/gaest/forkert{i}", s.base))
                .call()
                .unwrap_or_else(|e| panic!("{e}"))
                .status()
                .as_u16();
        }
        assert_eq!(last, 429);
    }
}
