//! Hvad skal der ske med én fil? Afgøres alene af tre hashes: basen (det, enheden og serveren
//! sidst var enige om), disken og serveren. Tidsstempler afgør aldrig noget: ure går forkert, og
//! mtime opdateres først, når et program lukker filen (oplægget, »Kendte fælder«).
//!
//! `None` betyder, at filen ikke findes (eller er en gravsten på serveren).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Disk og server er ens. Basen opdateres, hvis den er en anden.
    Nothing,
    /// Kun disken er ændret: send den.
    Upload,
    /// Kun serveren er ændret: hent og skriv atomisk.
    Download,
    /// Slettet på disken, uændret på serveren: slet på serveren.
    DeleteRemote,
    /// Slettet på serveren, uændret på disken: slet på disken (til papirkurven).
    DeleteLocal,
    /// Rettet her, slettet derovre: rettelsen vinder og sendes igen. Brugeren får besked.
    ResurrectUpload,
    /// Slettet her, rettet derovre: rettelsen vinder og hentes. Brugeren får besked.
    ResurrectDownload,
    /// Begge har rettet: flet (tekst) eller konfliktkopi.
    Merge,
}

pub fn decide(base: Option<&str>, local: Option<&str>, remote: Option<&str>) -> Action {
    if local == remote {
        return Action::Nothing;
    }
    if local == base {
        return match remote {
            None => Action::DeleteLocal,
            Some(_) => Action::Download,
        };
    }
    if remote == base {
        return match local {
            None => Action::DeleteRemote,
            Some(_) => Action::Upload,
        };
    }
    match (local, remote) {
        (None, Some(_)) => Action::ResurrectDownload,
        (Some(_), None) => Action::ResurrectUpload,
        _ => Action::Merge,
    }
}

#[cfg(test)]
mod tests {
    use super::Action::*;
    use super::*;

    #[test]
    fn hele_tabellen() {
        let (a, b, c) = (Some("a"), Some("b"), Some("c"));
        // (base, disk, server) → handling
        let cases = [
            (a, a, a, Nothing),
            (None, None, None, Nothing),
            (a, b, b, Nothing), // samme rettelse begge steder
            (a, None, None, Nothing),
            (a, b, a, Upload),
            (None, a, None, Upload), // ny fil her
            (a, a, b, Download),
            (None, None, a, Download), // ny fil derovre
            (a, None, a, DeleteRemote),
            (a, a, None, DeleteLocal),
            (a, b, None, ResurrectUpload),
            (a, None, b, ResurrectDownload),
            (a, b, c, Merge),
            (None, a, b, Merge), // oprettet begge steder med forskelligt indhold
        ];
        for (base, local, remote, want) in cases {
            assert_eq!(
                decide(base, local, remote),
                want,
                "{base:?} {local:?} {remote:?}"
            );
        }
    }
}
