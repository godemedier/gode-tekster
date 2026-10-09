fn main() {
    // Ikonet lægges i exe'en her. tauri-build ser ikke selv efter ændringer i mappen, så et nyt
    // ikon kom ikke med i bygget (natlig test 9/10).
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
