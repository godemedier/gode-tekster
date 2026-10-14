//! TLS til alle udgående kald (ureq). Windows bruger systemets TLS og certifikatlager, så et
//! firmacertifikat eller en proxy, Windows stoler på, også virker her. Telefonen har ingen af
//! delene og bruger rustls med de indbyggede rodcertifikater (Android-forsøget 14/10).

use ureq::tls::{RootCerts, TlsConfig, TlsProvider};

pub(crate) fn tls_config() -> TlsConfig {
    #[cfg(windows)]
    let (provider, roots) = (TlsProvider::NativeTls, RootCerts::PlatformVerifier);
    #[cfg(not(windows))]
    let (provider, roots) = (TlsProvider::Rustls, RootCerts::WebPki);
    TlsConfig::builder()
        .provider(provider)
        .root_certs(roots)
        .build()
}
