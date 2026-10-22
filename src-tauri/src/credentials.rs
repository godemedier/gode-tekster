//! Brugerens egne nøgler (Gemini, Mistral) i Windows' legitimationsadministrator. En nøgle forlader
//! aldrig Rust: fladen kan gemme og slette den, ikke læse den. Fælles for gemini.rs og mistral.rs
//! (6/10, da Mistral kom til).

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

#[cfg(windows)]
pub fn read(target: &str) -> Option<String> {
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };
    let target = wide(target);
    let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
    // SAFETY: Windows udfylder `cred`, som frigives med CredFree; blobben kopieres før frigivelsen.
    unsafe {
        if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) == 0 || cred.is_null() {
            return None;
        }
        let c = &*cred;
        let bytes =
            std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec();
        CredFree(cred.cast());
        String::from_utf8(bytes).ok().filter(|k| !k.is_empty())
    }
}

#[cfg(windows)]
pub fn write(target: &str, user: &str, key: &str) -> Result<(), String> {
    use windows_sys::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };
    let mut target = wide(target);
    let mut user = wide(user);
    let mut blob = key.as_bytes().to_vec();
    let cred = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        UserName: user.as_mut_ptr(),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..Default::default()
    };
    // SAFETY: alle pegepinde lever, til kaldet er færdigt.
    if unsafe { CredWriteW(&cred, 0) } == 0 {
        return Err(t!(
            "Nøglen kunne ikke gemmes i Windows' legitimationsadministrator.",
            "The key could not be saved in Windows Credential Manager."
        )
        .to_owned());
    }
    Ok(())
}

#[cfg(windows)]
pub fn delete(target: &str) {
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};
    let target = wide(target);
    // SAFETY: et rent kald med en nulafsluttet streng.
    unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) };
}

#[cfg(not(windows))]
pub fn read(_target: &str) -> Option<String> {
    None
}
#[cfg(not(windows))]
pub fn write(_target: &str, _user: &str, _key: &str) -> Result<(), String> {
    Err(t!("Kun på Windows.", "Windows only.").to_owned())
}
#[cfg(not(windows))]
pub fn delete(_target: &str) {}
