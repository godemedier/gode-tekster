//! Gæstens side til en delt tekst (ADR-0060): `del.html` og dens filer fra `dist-del/`, bygget af
//! `vite.del.config.ts` i Dockerfilen. Filerne læses ind i hukommelsen ved start, så kun de
//! byggede filer kan hentes, og intet navn fra adressen bliver til en sti på disken.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path as UrlPath, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

/// Siden og dens filer efter navn (`assets/del-abc.js`).
#[derive(Default)]
pub struct Site {
    page: Option<Bytes>,
    assets: HashMap<String, (&'static str, Bytes)>,
}

fn kind(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or_default() {
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "woff2" => "font/woff2",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

/// Kun skriptet, stylesheets og skrifter fra samme adresse. Ingen billeder udefra, ingen
/// indlejring i andre sider. `style-src 'unsafe-inline'`: CodeMirror lægger sine styles inline.
const CSP: &str =
    "default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; \
font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; \
frame-ancestors 'none'";

impl Site {
    /// Læs `dir` (dist-del). Mangler den, er der ingen side, og ruterne svarer 404.
    pub fn load(dir: &Path) -> Site {
        let mut site = Site {
            page: std::fs::read(dir.join("del.html")).ok().map(Bytes::from),
            ..Site::default()
        };
        if let Ok(entries) = std::fs::read_dir(dir.join("assets")) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                if let Ok(bytes) = std::fs::read(e.path()) {
                    site.assets
                        .insert(name.clone(), (kind(&name), Bytes::from(bytes)));
                }
            }
        }
        site
    }

    pub fn is_empty(&self) -> bool {
        self.page.is_none()
    }
}

fn secure(mut r: Response, cache: &'static str) -> Response {
    let h = r.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    h.insert(
        "x-robots-tag",
        HeaderValue::from_static("noindex, nofollow"),
    );
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    r
}

/// `/del/<link>`: siden er den samme for alle links. Den spørger selv serveren om linket.
pub async fn page(State(site): State<Arc<Site>>, UrlPath(_token): UrlPath<String>) -> Response {
    match &site.page {
        Some(html) => secure(
            (
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                html.clone(),
            )
                .into_response(),
            "no-store",
        ),
        None => (StatusCode::NOT_FOUND, "Siden findes ikke.").into_response(),
    }
}

/// `/del/assets/<fil>`: navnene har en hash, så de kan gemmes for altid.
pub async fn asset(State(site): State<Arc<Site>>, UrlPath(name): UrlPath<String>) -> Response {
    match site.assets.get(&name) {
        Some((kind, bytes)) => secure(
            ([(header::CONTENT_TYPE, *kind)], bytes.clone()).into_response(),
            "public, max-age=31536000, immutable",
        ),
        None => (StatusCode::NOT_FOUND, "Filen findes ikke.").into_response(),
    }
}

pub fn router(site: Site) -> Router {
    Router::new()
        .route("/del/assets/{name}", get(asset))
        .route("/del/{token}", get(page))
        .with_state(Arc::new(site))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kun_de_byggede_filer_kan_hentes() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        std::fs::create_dir_all(dir.path().join("assets")).unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(dir.path().join("del.html"), "<!doctype html>")
            .unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(dir.path().join("assets").join("del-abc.js"), "1")
            .unwrap_or_else(|e| panic!("{e}"));
        let site = Site::load(dir.path());
        assert!(!site.is_empty());
        assert!(site.assets.contains_key("del-abc.js"));
        assert!(!site.assets.contains_key("../del.html"));
        assert_eq!(kind("del-abc.js"), "text/javascript; charset=utf-8");
        assert!(Site::load(&dir.path().join("findes-ikke")).is_empty());
    }
}
