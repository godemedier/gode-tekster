//! Delinger i serverens lager (ADR-0060). En deling er en kopi af en del af en tekst, uden for de
//! synkede filer. Hver person har sit eget link og sin egen udgave. Kun linkets hash gemmes, og et
//! link virker ikke længere, når det er udløbet, eller delingen er trukket tilbage.

use rusqlite::{params, OptionalExtension, TransactionBehavior};

use crate::hash;
use crate::protokol::{GuestCopy, NewShare, ShareInfo, ShareLink};
use crate::store::{now, random_hex, Result, Store, StoreError};

/// Største delte tekst. En del af en tekst, ikke en bog.
pub const MAX_SHARE: usize = 1024 * 1024;
/// Standard for, hvor længe et link virker (besluttet 20/10).
pub const SHARE_DAYS: u32 = 30;
/// Så længe ligger en udløbet eller stoppet deling, før den slettes.
pub const SHARE_KEEP_SECS: i64 = 30 * 86_400;

/// Udfaldet af gæstens gem.
#[derive(Debug, PartialEq, Eq)]
pub enum GuestSaved {
    Saved(u64),
    /// Der er gemt oven på en anden udgave (fx i en anden fane). Den aktuelle følger med.
    Conflict {
        rev: u64,
        text: String,
    },
    /// Linket findes ikke, er udløbet eller trukket tilbage.
    Gone,
}

fn clean(s: &str, max: usize) -> String {
    let s: String = s.chars().filter(|c| !c.is_control()).take(max).collect();
    s.trim().to_owned()
}

type ShareRow = (String, String, i64, i64, Option<i64>);

impl Store {
    pub(crate) fn create_share_tables(&self) -> Result<()> {
        let db = self.db();
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS share(
               id TEXT PRIMARY KEY, title TEXT NOT NULL, base TEXT NOT NULL,
               created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER);
             CREATE TABLE IF NOT EXISTS share_link(
               id TEXT PRIMARY KEY, share TEXT NOT NULL, name TEXT NOT NULL,
               token_hash TEXT NOT NULL UNIQUE, text TEXT NOT NULL, rev INTEGER NOT NULL,
               updated INTEGER, last_seen INTEGER);",
        )?;
        // Afsenderens navn kom til 21/10. Ældre lagre får kolonnen her.
        let has_sender = db
            .prepare("SELECT 1 FROM pragma_table_info('share') WHERE name = 'sender'")?
            .exists([])?;
        if !has_sender {
            db.execute("ALTER TABLE share ADD COLUMN sender TEXT", [])?;
        }
        Ok(())
    }

    /// En ny deling med ét link pr. navn. Nøglerne returneres kun her.
    pub fn create_share(&self, s: &NewShare) -> Result<ShareInfo> {
        if s.text.len() > MAX_SHARE {
            return Err(StoreError::TooLarge);
        }
        let names: Vec<String> = s
            .names
            .iter()
            .map(|n| clean(n, 60))
            .filter(|n| !n.is_empty())
            .collect();
        if names.is_empty() || names.len() > 20 {
            return Err(StoreError::Invalid("Skriv mellem et og tyve navne.".into()));
        }
        let id = random_hex(8)?;
        let title = clean(&s.title, 120);
        let created = now();
        let expires = created + i64::from(s.days.unwrap_or(SHARE_DAYS).clamp(1, 365)) * 86_400;
        let mut links = Vec::new();
        let mut db = self.db();
        let tx = db.transaction()?;
        let sender = s
            .from
            .as_deref()
            .map(|n| clean(n, 80))
            .filter(|n| !n.is_empty());
        tx.execute(
            "INSERT INTO share(id, title, base, created, expires, sender) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, title, s.text, created, expires, sender],
        )?;
        for name in names {
            let link = random_hex(8)?;
            let token = random_hex(32)?;
            tx.execute(
                "INSERT INTO share_link(id, share, name, token_hash, text, rev)
                 VALUES (?1, ?2, ?3, ?4, ?5, 1)",
                params![link, id, name, hash(token.as_bytes()), s.text],
            )?;
            links.push(ShareLink {
                id: link,
                name,
                rev: 1,
                updated: None,
                last_seen: None,
                token: Some(token),
                text: None,
            });
        }
        tx.commit()?;
        Ok(ShareInfo {
            id,
            title,
            created,
            expires,
            revoked: false,
            links,
            base: None,
        })
    }

    fn links_of(&self, share: &str, with_text: bool) -> Result<Vec<ShareLink>> {
        let db = self.db();
        let mut stmt = db.prepare(
            "SELECT id, name, rev, updated, last_seen, text FROM share_link
             WHERE share = ?1 ORDER BY name",
        )?;
        let rows = stmt
            .query_map([share], |r| {
                Ok(ShareLink {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    rev: r.get::<_, i64>(2)? as u64,
                    updated: r.get(3)?,
                    last_seen: r.get(4)?,
                    token: None,
                    text: if with_text { Some(r.get(5)?) } else { None },
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Alle delinger, nyeste først, uden teksterne.
    pub fn shares(&self) -> Result<Vec<ShareInfo>> {
        let rows: Vec<ShareRow> = {
            let db = self.db();
            let mut stmt = db.prepare(
                "SELECT id, title, created, expires, revoked FROM share ORDER BY created DESC",
            )?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })?
                .collect::<rusqlite::Result<_>>()?;
            rows
        };
        rows.into_iter()
            .map(|(id, title, created, expires, revoked)| {
                Ok(ShareInfo {
                    links: self.links_of(&id, false)?,
                    id,
                    title,
                    created,
                    expires,
                    revoked: revoked.is_some(),
                    base: None,
                })
            })
            .collect()
    }

    /// Én deling med basen og hver persons udgave.
    pub fn share(&self, id: &str) -> Result<Option<ShareInfo>> {
        let row: Option<ShareRow> = self
            .db()
            .query_row(
                "SELECT title, base, created, expires, revoked FROM share WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        let Some((title, base, created, expires, revoked)) = row else {
            return Ok(None);
        };
        Ok(Some(ShareInfo {
            id: id.to_owned(),
            title,
            created,
            expires,
            revoked: revoked.is_some(),
            links: self.links_of(id, true)?,
            base: Some(base),
        }))
    }

    /// Træk en deling tilbage: alle dens links holder op med at virke med det samme.
    pub fn revoke_share(&self, id: &str) -> Result<bool> {
        let n = self.db().execute(
            "UPDATE share SET revoked = ?1 WHERE id = ?2 AND revoked IS NULL",
            params![now(), id],
        )?;
        Ok(n == 1)
    }

    /// Slet en deling helt, også gæsternes udgaver.
    pub fn delete_share(&self, id: &str) -> Result<bool> {
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM share_link WHERE share = ?1", [id])?;
        let n = tx.execute("DELETE FROM share WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(n == 1)
    }

    /// Delinger, der udløb eller blev stoppet for mere end 30 dage siden, slettes helt, også
    /// gæsternes udgaver (privatlivssiden lover det). Giver antallet.
    pub fn purge_shares(&self) -> Result<usize> {
        let limit = now() - SHARE_KEEP_SECS;
        let mut db = self.db();
        let tx = db.transaction()?;
        tx.execute(
            "DELETE FROM share_link WHERE share IN
               (SELECT id FROM share WHERE expires < ?1 OR revoked < ?1)",
            [limit],
        )?;
        let n = tx.execute(
            "DELETE FROM share WHERE expires < ?1 OR revoked < ?1",
            [limit],
        )?;
        tx.commit()?;
        Ok(n)
    }

    /// Linket bag en nøgle, hvis det virker.
    fn live_link(&self, token: &str) -> Result<Option<String>> {
        Ok(self
            .db()
            .query_row(
                "SELECT l.id FROM share_link l JOIN share s ON s.id = l.share
                 WHERE l.token_hash = ?1 AND s.revoked IS NULL AND s.expires > ?2",
                params![hash(token.as_bytes()), now()],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Gæstens udgave. `None`, når linket ikke virker. Opdaterer »sidst set«.
    pub fn guest_copy(&self, token: &str) -> Result<Option<GuestCopy>> {
        let Some(link) = self.live_link(token)? else {
            return Ok(None);
        };
        let db = self.db();
        db.execute(
            "UPDATE share_link SET last_seen = ?1 WHERE id = ?2",
            params![now(), link],
        )?;
        Ok(db
            .query_row(
                "SELECT s.title, l.name, l.text, l.rev, s.expires, s.sender
                 FROM share_link l JOIN share s ON s.id = l.share WHERE l.id = ?1",
                [&link],
                |r| {
                    Ok(GuestCopy {
                        title: r.get(0)?,
                        name: r.get(1)?,
                        text: r.get(2)?,
                        rev: r.get::<_, i64>(3)? as u64,
                        expires: r.get(4)?,
                        from: r.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    /// Gæsten gemmer. Kun oven på den revision, gæsten kender (compare-and-swap).
    pub fn guest_save(&self, token: &str, base_rev: u64, text: &str) -> Result<GuestSaved> {
        if text.len() > MAX_SHARE {
            return Err(StoreError::TooLarge);
        }
        let Some(link) = self.live_link(token)? else {
            return Ok(GuestSaved::Gone);
        };
        let mut db = self.db();
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (rev, current): (i64, String) = tx.query_row(
            "SELECT rev, text FROM share_link WHERE id = ?1",
            [&link],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if rev as u64 != base_rev {
            return Ok(GuestSaved::Conflict {
                rev: rev as u64,
                text: current,
            });
        }
        if current == text {
            return Ok(GuestSaved::Saved(rev as u64));
        }
        let next = rev + 1;
        tx.execute(
            "UPDATE share_link SET text = ?1, rev = ?2, updated = ?3, last_seen = ?3 WHERE id = ?4",
            params![text, next, now(), link],
        )?;
        tx.commit()?;
        Ok(GuestSaved::Saved(next as u64))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let s = Store::open(dir.path()).unwrap_or_else(|e| panic!("{e}"));
        (dir, s)
    }

    fn new(text: &str, names: &[&str]) -> NewShare {
        NewShare {
            title: "Kapitel 2".into(),
            text: text.into(),
            names: names.iter().map(|n| n.to_string()).collect(),
            days: None,
            from: Some("Kim Skribent".into()),
        }
    }

    /// En deling fra før afsenderens navn (21/10) virker stadig, når serveren er opdateret: kolonnen
    /// lægges til, rækkerne bevares, og gæsten kan både læse og gemme.
    #[test]
    fn gammel_deling_overlever_opdateringen() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        {
            let db = rusqlite::Connection::open(dir.path().join("synk.sqlite"))
                .unwrap_or_else(|e| panic!("{e}"));
            db.execute_batch(
                "CREATE TABLE share(
                   id TEXT PRIMARY KEY, title TEXT NOT NULL, base TEXT NOT NULL,
                   created INTEGER NOT NULL, expires INTEGER NOT NULL, revoked INTEGER);
                 CREATE TABLE share_link(
                   id TEXT PRIMARY KEY, share TEXT NOT NULL, name TEXT NOT NULL,
                   token_hash TEXT NOT NULL UNIQUE, text TEXT NOT NULL, rev INTEGER NOT NULL,
                   updated INTEGER, last_seen INTEGER);",
            )
            .unwrap_or_else(|e| panic!("{e}"));
            let far = now() + 86_400;
            db.execute(
                "INSERT INTO share(id, title, base, created, expires) VALUES ('s1', 'Kronik', 'Et afsnit.', 0, ?1)",
                [far],
            )
            .unwrap_or_else(|e| panic!("{e}"));
            db.execute(
                "INSERT INTO share_link(id, share, name, token_hash, text, rev) VALUES ('l1', 's1', 'Morten', ?1, 'Et afsnit.', 3)",
                [hash(b"gammelt-link")],
            )
            .unwrap_or_else(|e| panic!("{e}"));
        }
        let store = Store::open(dir.path()).unwrap_or_else(|e| panic!("{e}"));
        let copy = store
            .guest_copy("gammelt-link")
            .unwrap_or_else(|e| panic!("{e}"))
            .unwrap_or_else(|| panic!("den gamle deling er væk"));
        assert_eq!(
            (copy.name.as_str(), copy.rev, copy.from),
            ("Morten", 3, None)
        );
        let saved = store
            .guest_save("gammelt-link", 3, "Et afsnit. {++Ny++}")
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(matches!(saved, GuestSaved::Saved(4)));
        // Endnu en start (kolonnen findes nu): intet sker.
        drop(store);
        Store::open(dir.path()).unwrap_or_else(|e| panic!("{e}"));
    }

    /// Gæsten ser, hvem teksten er fra (21/10).
    #[test]
    fn gaesten_ser_afsenderen() {
        let (_dir, store) = store();
        let share = store
            .create_share(&new("Et afsnit.", &["Morten"]))
            .unwrap_or_else(|e| panic!("{e}"));
        let copy = store
            .guest_copy(&token(&share, 0))
            .unwrap_or_else(|e| panic!("{e}"))
            .unwrap_or_else(|| panic!("ingen kopi"));
        assert_eq!(copy.from.as_deref(), Some("Kim Skribent"));
    }

    fn token(share: &ShareInfo, i: usize) -> String {
        share.links[i].token.clone().unwrap_or_default()
    }

    #[test]
    fn hver_person_har_sin_egen_udgave_og_gemmer_med_cas() -> Result<()> {
        let (_d, s) = store();
        let share = s.create_share(&new("Et afsnit.", &["Kim", "Andreas"]))?;
        let (k, a) = (token(&share, 0), token(&share, 1));
        let copy = s.guest_copy(&a)?.map(|c| (c.name, c.text, c.rev));
        assert_eq!(copy, Some(("Andreas".into(), "Et afsnit.".into(), 1)));
        assert_eq!(
            s.guest_save(&a, 1, "Et {++kort ++}afsnit.")?,
            GuestSaved::Saved(2)
        );
        // En gammel fane gemmer oven på revision 1: konflikt med den aktuelle udgave.
        assert_eq!(
            s.guest_save(&a, 1, "andet")?,
            GuestSaved::Conflict {
                rev: 2,
                text: "Et {++kort ++}afsnit.".into()
            }
        );
        // Kims udgave er urørt.
        assert_eq!(s.guest_copy(&k)?.map(|c| c.text), Some("Et afsnit.".into()));
        let full = s
            .share(&share.id)?
            .unwrap_or_else(|| panic!("delingen mangler"));
        assert_eq!(full.base.as_deref(), Some("Et afsnit."));
        let andreas = full.links.iter().find(|l| l.name == "Andreas");
        assert_eq!(
            andreas.and_then(|l| l.text.as_deref()),
            Some("Et {++kort ++}afsnit.")
        );
        // Listen har ingen tekster og ingen nøgler.
        let list = s.shares()?;
        assert!(list[0]
            .links
            .iter()
            .all(|l| l.text.is_none() && l.token.is_none()));
        Ok(())
    }

    #[test]
    fn tilbagetrukket_udloebet_og_ukendt_link_virker_ikke() -> Result<()> {
        let (_d, s) = store();
        let share = s.create_share(&new("Tekst", &["Andreas"]))?;
        let t = token(&share, 0);
        assert!(s.guest_copy("forkert")?.is_none());
        assert!(s.revoke_share(&share.id)?);
        assert!(s.guest_copy(&t)?.is_none());
        assert_eq!(s.guest_save(&t, 1, "x")?, GuestSaved::Gone);

        let share = s.create_share(&new("Tekst", &["Andreas"]))?;
        let t = token(&share, 0);
        s.db()
            .execute("UPDATE share SET expires = 0 WHERE id = ?1", [&share.id])?;
        assert!(s.guest_copy(&t)?.is_none());
        // Udløbet for længe siden: slettes ved oprydningen. En levende deling og en, der lige er
        // stoppet, bliver (den stoppede i 30 dage).
        let live = s.create_share(&new("Tekst", &["Kim"]))?;
        assert_eq!(s.purge_shares()?, 1);
        assert!(s.share(&live.id)?.is_some());
        assert!(s.share(&share.id)?.is_none());
        assert_eq!(s.shares()?.len(), 2);
        Ok(())
    }

    #[test]
    fn navne_og_stoerrelse_tjekkes() {
        let (_d, s) = store();
        assert!(matches!(
            s.create_share(&new("x", &["  "])),
            Err(StoreError::Invalid(_))
        ));
        assert!(matches!(
            s.create_share(&new(&"x".repeat(MAX_SHARE + 1), &["A"])),
            Err(StoreError::TooLarge)
        ));
    }
}
