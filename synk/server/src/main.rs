//! synk.godemedier.dk: lageret til Gode Teksters synkronisering (ADR-0054).
//!
//!   GET    /api/health                  husets kontrakt (REGISTRY §10)
//!   POST   /v1/enheder                  ny enhed: ejerens ADMIN_TOKEN eller en parringskode
//!   GET    /v1/enheder                  enhederne (ejeren)
//!   DELETE /v1/enheder/{id}             slå en enhed fra (ejeren)
//!   POST   /v1/parringskode             engangskode til en ny enhed (ejeren)
//!   GET    /v1/aendringer?siden=N       alt ændret efter løbenummer N
//!   GET    /v1/fil?sti=…                én fil, som serveren kender den
//!   GET    /v1/historik?sti=…           alle revisioner af en fil
//!   GET    /v1/papirkurv                filer slettet inden for 30 dage (kan hentes tilbage)
//!   GET    /v1/blob/{hash}              indhold
//!   PUT    /v1/blob/{hash}              læg indhold op (hashen efterprøves)
//!   POST   /v1/commit                   ny revision oven på en kendt (409 med den aktuelle)
//!   GET    /v1/lyt                      Server-Sent Events: »seq er nu N«
//!
//! Én gang i døgnet (og ved start) fjernes indhold, som kun filer slettet for mere end 30 dage
//! siden brugte (`Store::purge`).
//!
//! Serveren fletter aldrig. Enhederne fletter selv og skriver kun oven på den revision, de har
//! set. Tekstens indhold er data, aldrig instruktioner: serveren læser det ikke.
//!
//! Miljø: `DATA_DIR` (lager), `PORT`, `ADMIN_TOKEN` (mindst 32 tegn, kun til den første enhed).

mod api;

use std::sync::Arc;

use synk_kerne::store::Store;

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("synk-server stoppede: {e}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::var("DATA_DIR").unwrap_or_else(|_| "/data".into());
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3000);
    let admin = std::env::var("ADMIN_TOKEN").ok().filter(|t| t.len() >= 32);
    if admin.is_none() {
        eprintln!("ADMIN_TOKEN mangler eller er for kort: nye enheder kan kun parres med en kode");
    }
    let store = Arc::new(Store::open(std::path::Path::new(&dir))?);
    tokio::spawn(purge_daily(store.clone()));
    let app = api::router(api::App::new(store, admin)?);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    eprintln!("synk-server lytter på {port}, lager i {dir}");
    axum::serve(listener, app)
        .with_graceful_shutdown(stop())
        .await?;
    Ok(())
}

/// Papirkurven tømmes for det, der er ældre end 30 dage. Første gang ved start.
async fn purge_daily(store: Arc<Store>) {
    let mut every = tokio::time::interval(std::time::Duration::from_secs(86_400));
    loop {
        every.tick().await;
        let s = store.clone();
        match tokio::task::spawn_blocking(move || s.purge()).await {
            Ok(Ok(0)) => {}
            Ok(Ok(n)) => eprintln!("papirkurven: {n} gamle udgaver fjernet"),
            Ok(Err(e)) => eprintln!("papirkurven kunne ikke tømmes: {e}"),
            Err(e) => eprintln!("papirkurven kunne ikke tømmes: {e}"),
        }
    }
}

/// Docker stopper med SIGTERM, en terminal med Ctrl+C. En commit, der er i gang, gøres færdig.
async fn stop() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        if let Ok(mut term) = signal(SignalKind::terminate()) {
            tokio::select! {
                _ = term.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
            return;
        }
    }
    let _ = tokio::signal::ctrl_c().await;
}
