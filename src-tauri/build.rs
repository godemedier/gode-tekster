fn main() {
    // Ikonet lægges i exe'en her. tauri-build ser ikke selv efter ændringer i mappen, så et nyt
    // ikon kom ikke med i bygget (natlig test 9/10).
    println!("cargo:rerun-if-changed=icons");
    hunspell();
    tauri_build::build()
}

/// Hunspell 1.7.5 (vendor/hunspell, ADR-0063) bygges statisk ind i programmet. Kun bibliotekets
/// egne filer, uændrede. `/utf-8`, fordi kilden har UTF-8 i strenge og kommentarer.
fn hunspell() {
    const FILES: &[&str] = &[
        "affentry",
        "affixmgr",
        "csutil",
        "filemgr",
        "hashmgr",
        "hunspell",
        "hunspelltrace",
        "hunzip",
        "phonet",
        "replist",
        "suggestmgr",
    ];
    println!("cargo:rerun-if-changed=vendor/hunspell/src");
    let mut b = cc::Build::new();
    // Altid optimeret, også i `cargo test` og `tauri dev`: uoptimeret tager ordbogen sekunder.
    b.cpp(true)
        .opt_level(2)
        .define("HUNSPELL_STATIC", None)
        .define("BUILDING_LIBHUNSPELL", None)
        .std("c++14")
        .warnings(false)
        .flag_if_supported("/EHsc")
        .flag_if_supported("/utf-8");
    for f in FILES {
        b.file(format!("vendor/hunspell/src/{f}.cxx"));
    }
    b.compile("hunspell");
}
