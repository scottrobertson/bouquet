use std::collections::BTreeMap;

use rusqlite::{Connection, params};

use super::mutations::*;
use crate::output::{m3u::build_m3u, resolve::get_playlist_output};
use crate::smart_sort::SmartSortConfig;
use crate::test_support;

struct T {
    _db: crate::db::Db,
    conn: std::sync::MutexGuard<'static, Connection>,
    source: i64,
    playlist: i64,
    category: i64,
}

fn setup() -> T {
    // Leaked so the guard can live alongside it; each test gets its own
    // in-memory database, so the leak is a few kilobytes per test.
    let db: &'static crate::db::Db = Box::leak(Box::new(test_support::db()));
    let conn = db.lock();
    let source = test_support::source(&conn, "Main");
    let playlist = test_support::playlist(&conn, "tok", "tok");
    let category = test_support::category(&conn, playlist, "UK", 0);
    T { _db: db.clone(), conn, source, playlist, category }
}

#[derive(Debug, Clone, PartialEq)]
struct Row {
    id: i64,
    category_id: i64,
    source_channel_id: i64,
    custom_name: Option<String>,
    custom_logo: Option<String>,
    position: i64,
    enabled: bool,
    epg_source_id: Option<i64>,
    epg_channel_id: Option<String>,
    primary_channel_id: Option<i64>,
    alt_position: i64,
    auto_disabled_at: Option<i64>,
}

impl T {
    fn sc(&self, stream: &str, name: &str) -> i64 {
        test_support::source_channel(&self.conn, self.source, stream, name, "UK")
    }

    fn row(&self, id: i64) -> Option<Row> {
        self.conn
            .query_row(
                "SELECT id, category_id, source_channel_id, custom_name, custom_logo, position, enabled, epg_source_id, \
                   epg_channel_id, primary_channel_id, alt_position, auto_disabled_at FROM playlist_channels WHERE id = ?",
                [id],
                |r| {
                    Ok(Row {
                        id: r.get(0)?,
                        category_id: r.get(1)?,
                        source_channel_id: r.get(2)?,
                        custom_name: r.get(3)?,
                        custom_logo: r.get(4)?,
                        position: r.get(5)?,
                        enabled: r.get(6)?,
                        epg_source_id: r.get(7)?,
                        epg_channel_id: r.get(8)?,
                        primary_channel_id: r.get(9)?,
                        alt_position: r.get(10)?,
                        auto_disabled_at: r.get(11)?,
                    })
                },
            )
            .ok()
    }

    fn r(&self, id: i64) -> Row {
        self.row(id).unwrap()
    }

    fn pc_for(&self, playlist: i64, category: i64, sc: i64) -> i64 {
        self.conn
            .query_row(
                "SELECT id FROM playlist_channels WHERE playlist_id = ? AND category_id = ? AND source_channel_id = ?",
                params![playlist, category, sc],
                |r| r.get(0),
            )
            .unwrap()
    }

    /// Add source channels named `names` to a category; returns playlist channel ids.
    fn seed_in(&self, playlist: i64, category: i64, names: &[&str]) -> Vec<i64> {
        let scs: Vec<i64> = names.iter().map(|n| self.sc(&n.to_lowercase(), n)).collect();
        add_channels(&self.conn, playlist, category, &scs, None).unwrap();
        scs.iter().map(|sc| self.pc_for(playlist, category, *sc)).collect()
    }

    fn seed(&self, names: &[&str]) -> Vec<i64> {
        self.seed_in(self.playlist, self.category, names)
    }

    /// Primary channel ids in a category, in display order.
    fn order(&self, category: i64) -> Vec<i64> {
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM playlist_channels WHERE category_id = ? AND primary_channel_id IS NULL ORDER BY position, id")
            .unwrap();
        stmt.query_map([category], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    fn names_in_order(&self, category: i64) -> Vec<String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT coalesce(pc.custom_name, sc.name) FROM playlist_channels pc JOIN source_channels sc \
                 ON pc.source_channel_id = sc.id WHERE pc.category_id = ? ORDER BY pc.position, pc.id",
            )
            .unwrap();
        stmt.query_map([category], |r| r.get(0)).unwrap().map(|r| r.unwrap()).collect()
    }

    fn output(&self) -> Vec<crate::output::resolve::ResolvedChannel> {
        get_playlist_output(&self.conn, "tok").unwrap().unwrap().1
    }

    fn output_names(&self) -> Vec<String> {
        self.output().into_iter().map(|c| c.display_name).collect()
    }

    fn add_category(&self, playlist: i64, name: &str, position: i64) -> i64 {
        test_support::category(&self.conn, playlist, name, position)
    }

    fn add_playlist(&self, token: &str) -> i64 {
        test_support::playlist(&self.conn, token, token)
    }

    fn category_row(&self, id: i64) -> Option<(String, i64)> {
        self.conn.query_row("SELECT name, position FROM playlist_categories WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?))).ok()
    }

    fn exec(&self, sql: &str, p: impl rusqlite::Params) {
        self.conn.execute(sql, p).unwrap();
    }
}

fn order_map(entries: &[(i64, Vec<i64>)]) -> BTreeMap<String, Vec<i64>> {
    entries.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

// Categories

#[test]
fn create_category_trims_and_appends() {
    let t = setup();
    let id = create_category(&t.conn, t.playlist, "  Sport  ").unwrap().unwrap();
    assert_eq!(t.category_row(id), Some(("Sport".into(), 1)));
    assert_eq!(create_category(&t.conn, t.playlist, "   ").unwrap(), None);
}

#[test]
fn create_auto_category_mirrors_a_source_category() {
    let t = setup();
    t.sc("a", "Channel A");
    let id = create_auto_category(&t.conn, t.playlist, t.source, "UK", " Auto UK ").unwrap().unwrap();
    assert_eq!(t.category_row(id), Some(("Auto UK".into(), 1)));
    let (auto_source, auto_name): (Option<i64>, Option<String>) = t
        .conn
        .query_row("SELECT auto_source_id, auto_category_name FROM playlist_categories WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!((auto_source, auto_name.as_deref()), (Some(t.source), Some("UK")));
    assert_eq!(t.output_names(), ["Channel A"]);
    assert_eq!(create_auto_category(&t.conn, t.playlist, t.source, "UK", " ").unwrap(), None);
    assert_eq!(create_auto_category(&t.conn, t.playlist, t.source, " ", "Auto").unwrap(), None);
}

#[test]
fn rename_category_rules() {
    let t = setup();
    rename_category(&t.conn, t.playlist, t.category, "  News ").unwrap();
    assert_eq!(t.category_row(t.category).unwrap().0, "News");
    rename_category(&t.conn, t.playlist, t.category, "  ").unwrap();
    assert_eq!(t.category_row(t.category).unwrap().0, "News");
    let other = t.add_playlist("other");
    rename_category(&t.conn, other, t.category, "Hijacked").unwrap();
    assert_eq!(t.category_row(t.category).unwrap().0, "News");
}

#[test]
fn delete_category_takes_its_channels() {
    let t = setup();
    let ids = t.seed(&["A", "B", "C"]);
    make_alternates(&t.conn, t.playlist, ids[0], &[ids[1]]).unwrap();
    let sport = t.add_category(t.playlist, "Sport", 1);
    let s = t.seed_in(t.playlist, sport, &["S"]);
    let other = t.add_playlist("other");
    delete_category(&t.conn, other, t.category).unwrap();
    assert!(t.category_row(t.category).is_some());

    delete_category(&t.conn, t.playlist, t.category).unwrap();
    assert!(t.category_row(t.category).is_none());
    assert!(ids.iter().all(|id| t.row(*id).is_none()));
    assert!(t.row(s[0]).is_some());
}

#[test]
fn reorder_categories_skips_other_playlists() {
    let t = setup();
    let sport = t.add_category(t.playlist, "Sport", 1);
    let news = t.add_category(t.playlist, "News", 2);
    let other = t.add_playlist("other");
    let foreign = t.add_category(other, "Theirs", 5);
    reorder_categories(&t.conn, t.playlist, &[news, foreign, t.category, sport]).unwrap();
    assert_eq!(t.category_row(news).unwrap().1, 0);
    assert_eq!(t.category_row(t.category).unwrap().1, 2);
    assert_eq!(t.category_row(sport).unwrap().1, 3);
    assert_eq!(t.category_row(foreign).unwrap().1, 5);
}

// Moving channels

#[test]
fn reorder_moves_a_channel_to_the_dropped_spot() {
    let t = setup();
    let sport = t.add_category(t.playlist, "Sport", 1);
    let ab = t.seed(&["A", "B"]);
    let s = t.seed_in(t.playlist, sport, &["S1", "S2"]);
    reorder_channels(&t.conn, t.playlist, ab[0], sport, &order_map(&[(t.category, vec![ab[1]]), (sport, vec![s[0], ab[0], s[1]])])).unwrap();
    assert_eq!(t.r(ab[0]).category_id, sport);
    assert_eq!(t.order(sport), [s[0], ab[0], s[1]]);
    assert_eq!(t.order(t.category), [ab[1]]);
}

#[test]
fn reorder_brings_alternates_along() {
    let t = setup();
    let sport = t.add_category(t.playlist, "Sport", 1);
    let ids = t.seed(&["A", "B", "C"]);
    make_alternates(&t.conn, t.playlist, ids[0], &[ids[1], ids[2]]).unwrap();
    reorder_channels(&t.conn, t.playlist, ids[0], sport, &order_map(&[(sport, vec![ids[0]])])).unwrap();
    assert_eq!(t.r(ids[1]).category_id, sport);
    assert_eq!(t.r(ids[2]).category_id, sport);
}

#[test]
fn reorder_refuses_an_auto_category() {
    let t = setup();
    let auto = create_auto_category(&t.conn, t.playlist, t.source, "UK", "Auto").unwrap().unwrap();
    let a = t.seed(&["A"])[0];
    reorder_channels(&t.conn, t.playlist, a, auto, &order_map(&[(auto, vec![a])])).unwrap();
    assert_eq!(t.r(a).category_id, t.category);
}

#[test]
fn reorder_leaves_other_playlists_alone() {
    let t = setup();
    let other = t.add_playlist("other");
    let other_cat = t.add_category(other, "Theirs", 0);
    let theirs = t.seed_in(other, other_cat, &["T"])[0];
    let ab = t.seed(&["A", "B"]);
    reorder_channels(&t.conn, t.playlist, ab[0], t.category, &order_map(&[(t.category, vec![ab[1], theirs, ab[0]])])).unwrap();
    assert_eq!(t.r(theirs).category_id, other_cat);
    assert_eq!(t.r(theirs).position, 0);
    assert_eq!(t.order(t.category), [ab[1], ab[0]]);
}

#[test]
fn bulk_move_appends_and_keeps_groups_together() {
    let t = setup();
    let sport = t.add_category(t.playlist, "Sport", 1);
    let ab = t.seed(&["A", "B"]);
    let s = t.seed_in(t.playlist, sport, &["S"])[0];
    bulk_move(&t.conn, t.playlist, &ab, sport).unwrap();
    assert_eq!(t.order(sport), [s, ab[0], ab[1]]);
    assert!(t.order(t.category).is_empty());
}

#[test]
fn bulk_move_with_alternates() {
    let t = setup();
    let sport = t.add_category(t.playlist, "Sport", 1);
    let ab = t.seed(&["A", "B"]);
    make_alternates(&t.conn, t.playlist, ab[0], &[ab[1]]).unwrap();
    // An alternate moved on its own snaps back to its primary.
    bulk_move(&t.conn, t.playlist, &[ab[1]], sport).unwrap();
    assert_eq!(t.r(ab[1]).category_id, t.category);
    bulk_move(&t.conn, t.playlist, &[ab[0]], sport).unwrap();
    assert_eq!(t.r(ab[1]).category_id, sport);
    assert_eq!(t.r(ab[1]).primary_channel_id, Some(ab[0]));
    let auto = create_auto_category(&t.conn, t.playlist, t.source, "UK", "Auto").unwrap().unwrap();
    bulk_move(&t.conn, t.playlist, &[ab[0]], auto).unwrap();
    assert_eq!(t.r(ab[0]).category_id, sport);
}

// Toggling

#[test]
fn bulk_toggle_clears_the_marker_and_resets_the_streak() {
    let t = setup();
    let ab = t.seed(&["A", "B"]);
    t.exec("UPDATE playlist_channels SET auto_disabled_at = 1 WHERE id = ?", [ab[0]]);
    bulk_toggle(&t.conn, t.playlist, &ab, false).unwrap();
    assert!(!t.r(ab[0]).enabled);
    assert_eq!(t.r(ab[0]).auto_disabled_at, None);
    assert!(!t.r(ab[1]).enabled);

    t.exec("UPDATE source_channels SET consecutive_probe_failures = 4", []);
    bulk_toggle(&t.conn, t.playlist, &[ab[0]], true).unwrap();
    assert!(t.r(ab[0]).enabled);
    let f: i64 = t
        .conn
        .query_row("SELECT consecutive_probe_failures FROM source_channels WHERE id = ?", [t.r(ab[0]).source_channel_id], |r| r.get(0))
        .unwrap();
    assert_eq!(f, 0);

    let other = t.add_playlist("other");
    let theirs = t.seed_in(other, t.add_category(other, "Theirs", 0), &["T"])[0];
    bulk_toggle(&t.conn, t.playlist, &[theirs], false).unwrap();
    assert!(t.r(theirs).enabled);
}

// Renaming

#[test]
fn bulk_rename_prefix_suffix_replace() {
    let t = setup();
    let ab = t.seed(&["BBC One", "BBC Two"]);
    rename_channel(&t.conn, t.playlist, ab[1], "Two").unwrap();
    bulk_add_prefix(&t.conn, t.playlist, &ab, "UK: ").unwrap();
    assert_eq!(t.r(ab[0]).custom_name.as_deref(), Some("UK: BBC One"));
    assert_eq!(t.r(ab[1]).custom_name.as_deref(), Some("UK: Two"));

    let c = t.seed(&["BBC Three"])[0];
    bulk_add_suffix(&t.conn, t.playlist, &[c], " HD").unwrap();
    assert_eq!(t.r(c).custom_name.as_deref(), Some("BBC Three HD"));
    // Landing back on the provider's name drops the custom name.
    bulk_replace(&t.conn, t.playlist, &[c], " HD", "").unwrap();
    assert_eq!(t.r(c).custom_name, None);

    let d = t.seed(&["Sky (UK) Sports (UK)"])[0];
    bulk_replace(&t.conn, t.playlist, &[d], "(UK)", "[GB]").unwrap();
    assert_eq!(t.r(d).custom_name.as_deref(), Some("Sky [GB] Sports [GB]"));

    let e = t.seed(&["Plain"])[0];
    bulk_add_prefix(&t.conn, t.playlist, &[e], "").unwrap();
    bulk_add_suffix(&t.conn, t.playlist, &[e], "").unwrap();
    bulk_replace(&t.conn, t.playlist, &[e], "", "x").unwrap();
    assert_eq!(t.r(e).custom_name, None);
}

#[test]
fn bulk_rename_skips_alternates() {
    let t = setup();
    let ab = t.seed(&["BBC One", "BBC One Backup"]);
    make_alternates(&t.conn, t.playlist, ab[0], &[ab[1]]).unwrap();
    bulk_add_prefix(&t.conn, t.playlist, &ab, "UK: ").unwrap();
    assert_eq!(t.r(ab[1]).custom_name, None);
    assert_eq!(t.output_names(), ["UK: BBC One", "UK: BBC One (Alt 1)"]);
}

// Alternates

#[test]
fn add_alternates_appends_with_the_group_guide() {
    let t = setup();
    let ab = t.seed(&["A", "B"]);
    set_epg(&t.conn, t.playlist, ab[0], Some(t.source), Some("group.epg")).unwrap();
    make_alternates(&t.conn, t.playlist, ab[0], &[ab[1]]).unwrap();
    let x = t.sc("x", "X");
    let y = t.sc("y", "Y");
    assert_eq!(add_alternates(&t.conn, t.playlist, ab[0], &[y, x]).unwrap(), [y, x]);
    let ry = t.r(t.pc_for(t.playlist, t.category, y));
    let rx = t.r(t.pc_for(t.playlist, t.category, x));
    assert_eq!((ry.primary_channel_id, ry.alt_position), (Some(ab[0]), 1));
    assert_eq!(rx.alt_position, 2);
    assert_eq!(rx.epg_channel_id.as_deref(), Some("group.epg"));
    // Already in the category, or an alternate as the primary: nothing added.
    let b_sc = t.r(ab[1]).source_channel_id;
    assert!(add_alternates(&t.conn, t.playlist, ab[0], &[b_sc]).unwrap().is_empty());
    let z = t.sc("z", "Z");
    assert!(add_alternates(&t.conn, t.playlist, ab[1], &[z]).unwrap().is_empty());
}

#[test]
fn make_alternates_nests_and_inherits() {
    let t = setup();
    let ids = t.seed(&["Channel A", "Channel B", "Channel C"]);
    set_epg(&t.conn, t.playlist, ids[0], Some(t.source), Some("bbc.epg")).unwrap();
    rename_channel(&t.conn, t.playlist, ids[1], "Custom B").unwrap();
    make_alternates(&t.conn, t.playlist, ids[0], &[ids[1], ids[2]]).unwrap();
    let (b, c) = (t.r(ids[1]), t.r(ids[2]));
    assert_eq!((b.primary_channel_id, b.alt_position), (Some(ids[0]), 0));
    assert_eq!((c.primary_channel_id, c.alt_position), (Some(ids[0]), 1));
    assert_eq!(b.epg_channel_id.as_deref(), Some("bbc.epg"));
    assert_eq!(b.epg_source_id, Some(t.source));
    assert_eq!(b.custom_name, None);
}

#[test]
fn make_alternates_refuses_to_nest_groups() {
    let t = setup();
    let ids = t.seed(&["A", "B", "C"]);
    make_alternates(&t.conn, t.playlist, ids[0], &[ids[1]]).unwrap();
    make_alternates(&t.conn, t.playlist, ids[1], &[ids[2]]).unwrap();
    assert_eq!(t.r(ids[2]).primary_channel_id, None);
}

#[test]
fn make_alternates_folds_in_and_moves_between_groups() {
    let t = setup();
    let ids = t.seed(&["A", "B", "C", "D"]);
    make_alternates(&t.conn, t.playlist, ids[0], &[ids[1], ids[2]]).unwrap();
    make_alternates(&t.conn, t.playlist, ids[0], &[ids[3]]).unwrap();
    assert_eq!((t.r(ids[3]).primary_channel_id, t.r(ids[3]).alt_position), (Some(ids[0]), 2));

    let e = t.seed(&["E"])[0];
    make_alternates(&t.conn, t.playlist, e, &[ids[1]]).unwrap();
    assert_eq!(t.r(ids[1]).primary_channel_id, Some(e));
    assert_eq!(t.r(ids[2]).alt_position, 0);
}

#[test]
fn ungroup_alternate_and_primary() {
    let t = setup();
    let ids = t.seed(&["A", "B", "C", "D"]);
    make_alternates(&t.conn, t.playlist, ids[0], &[ids[1], ids[2]]).unwrap();
    ungroup_alternate(&t.conn, t.playlist, ids[1]).unwrap();
    assert_eq!(t.r(ids[1]).primary_channel_id, None);
    assert_eq!(t.r(ids[2]).alt_position, 0);
    assert_eq!(t.order(t.category), [ids[0], ids[3], ids[1]]);
    // Not an alternate, so nothing changes.
    ungroup_alternate(&t.conn, t.playlist, ids[0]).unwrap();
    assert_eq!(t.order(t.category), [ids[0], ids[3], ids[1]]);
}

#[test]
fn ungroup_primary_frees_every_alternate() {
    let t = setup();
    let ids = t.seed(&["A", "B", "C", "D"]);
    make_alternates(&t.conn, t.playlist, ids[0], &[ids[1], ids[2]]).unwrap();
    ungroup_primary(&t.conn, t.playlist, ids[0]).unwrap();
    assert_eq!(t.r(ids[1]).primary_channel_id, None);
    assert_eq!(t.r(ids[2]).primary_channel_id, None);
    let order = t.order(t.category);
    assert_eq!(order[..2], [ids[0], ids[3]]);
    let mut rest = order[2..].to_vec();
    rest.sort();
    assert_eq!(rest, [ids[1], ids[2]]);
    assert_ne!(t.r(ids[1]).position, t.r(ids[2]).position);
    assert_eq!(t.output_names().len(), 4);
}

#[test]
fn reorder_alternates_saves_the_order() {
    let t = setup();
    let ids = t.seed(&["A", "B", "C"]);
    make_alternates(&t.conn, t.playlist, ids[0], &[ids[1], ids[2]]).unwrap();
    reorder_alternates(&t.conn, t.playlist, ids[0], &[ids[2], ids[1]]).unwrap();
    assert_eq!(t.r(ids[2]).alt_position, 0);
    assert_eq!(t.r(ids[1]).alt_position, 1);
}

#[test]
fn bulk_reset_epg_leaves_alternates_alone() {
    let t = setup();
    let ids = t.seed(&["A", "B", "C"]);
    set_epg(&t.conn, t.playlist, ids[0], Some(t.source), Some("custom.epg")).unwrap();
    set_epg(&t.conn, t.playlist, ids[2], None, None).unwrap();
    make_alternates(&t.conn, t.playlist, ids[0], &[ids[1]]).unwrap();
    bulk_reset_epg(&t.conn, t.playlist, &ids).unwrap();
    assert_eq!(t.r(ids[0]).epg_channel_id.as_deref(), Some("a.epg"));
    assert_eq!(t.r(ids[2]).epg_channel_id.as_deref(), Some("c.epg"));
    assert_eq!(t.r(ids[2]).epg_source_id, Some(t.source));
    assert_eq!(t.r(ids[1]).epg_channel_id.as_deref(), Some("custom.epg"));
}

// Output of alternate groups

fn three(t: &T) -> (i64, i64, i64) {
    let ids = t.seed(&["Channel A", "Channel B", "Channel C"]);
    (ids[0], ids[1], ids[2])
}

#[test]
fn output_names_alternates_after_their_primary() {
    let t = setup();
    let (a, b, c) = three(&t);
    set_epg(&t.conn, t.playlist, a, Some(t.source), Some("bbc.epg")).unwrap();
    rename_channel(&t.conn, t.playlist, a, "BBC One").unwrap();
    make_alternates(&t.conn, t.playlist, a, &[b, c]).unwrap();
    let out = t.output();
    assert_eq!(out.iter().map(|c| c.display_name.as_str()).collect::<Vec<_>>(), ["BBC One", "BBC One (Alt 1)", "BBC One (Alt 2)"]);
    assert!(out.iter().all(|c| c.tvg_id == "bbc.epg"));
    assert_eq!(build_m3u(&out, "http://host/epg").matches("#EXTINF").count(), 3);

    // Renaming an alternate does nothing, and a leftover stored name is ignored.
    rename_channel(&t.conn, t.playlist, b, "My Backup").unwrap();
    t.exec("UPDATE playlist_channels SET custom_name = 'Old Backup Name' WHERE id = ?", [c]);
    assert_eq!(t.output_names(), ["BBC One", "BBC One (Alt 1)", "BBC One (Alt 2)"]);

    rename_channel(&t.conn, t.playlist, a, "Sky One").unwrap();
    assert_eq!(t.output_names(), ["Sky One", "Sky One (Alt 1)", "Sky One (Alt 2)"]);
}

#[test]
fn alternates_use_the_primary_guide_and_logo() {
    let t = setup();
    let (a, b, c) = three(&t);
    set_epg(&t.conn, t.playlist, a, Some(t.source), Some("bbc.epg")).unwrap();
    t.exec("UPDATE playlist_channels SET custom_logo = 'http://logo/primary.png' WHERE id = ?", [a]);
    make_alternates(&t.conn, t.playlist, a, &[b, c]).unwrap();
    set_epg(&t.conn, t.playlist, a, Some(t.source), Some("bbc2.epg")).unwrap();
    t.exec("UPDATE playlist_channels SET epg_channel_id = 'rogue.epg', custom_logo = 'http://logo/rogue.png' WHERE id = ?", [b]);
    let out = t.output();
    assert!(out.iter().all(|c| c.tvg_id == "bbc2.epg"));
    assert!(out.iter().all(|c| c.logo == "http://logo/primary.png"));
}

#[test]
fn a_disabled_primary_takes_its_group_out() {
    let t = setup();
    let (a, b, c) = three(&t);
    rename_channel(&t.conn, t.playlist, a, "BBC One").unwrap();
    make_alternates(&t.conn, t.playlist, a, &[b, c]).unwrap();
    toggle_channel(&t.conn, t.playlist, c, false).unwrap();
    toggle_channel(&t.conn, t.playlist, a, false).unwrap();
    assert!(t.output().is_empty());
    toggle_channel(&t.conn, t.playlist, a, true).unwrap();
    assert_eq!(t.output_names(), ["BBC One", "BBC One (Alt 1)"]);
}

#[test]
fn channel_templates_apply_to_everything_but_alternates() {
    let t = setup();
    let (a, b, _) = three(&t);
    rename_channel(&t.conn, t.playlist, a, "BBC One").unwrap();
    make_alternates(&t.conn, t.playlist, a, &[b]).unwrap();
    t.exec(
        "UPDATE playlists SET channel_name_template = '{name} ({provider_letter})', alt_name_template = '{name} (Alt {n} - {provider_letter})'",
        [],
    );
    assert_eq!(t.output_names(), ["BBC One (M)", "BBC One (Alt 1 - M)", "Channel C (M)"]);
}

#[test]
fn channel_template_applies_to_auto_groups() {
    let t = setup();
    t.sc("a", "Channel A");
    t.exec(
        "INSERT INTO playlist_categories (playlist_id, name, position, auto_source_id, auto_category_name) VALUES (?, 'Auto', 1, ?, 'UK')",
        params![t.playlist, t.source],
    );
    t.exec("UPDATE playlists SET channel_name_template = '[{provider}] {name}'", []);
    assert_eq!(t.output_names(), ["[Main] Channel A"]);
}

#[test]
fn logos_borrow_from_a_custom_epg_pick() {
    let t = setup();
    let (a, _, _) = three(&t);
    t.exec(
        "INSERT INTO source_epg_channels (source_id, channel_id, display_name, icon) VALUES (?, 'b.epg', 'b.epg', 'http://logo/b.png'), \
         (?, 'a.epg', 'a.epg', 'http://logo/a-epg.png')",
        params![t.source, t.source],
    );
    t.exec("UPDATE source_channels SET logo = 'http://logo/a.png' WHERE stream_id = 'channel b'", []);
    // The source's own default EPG doesn't override the logo.
    let b_out = t.output().into_iter().find(|c| c.display_name == "Channel B").unwrap();
    assert_eq!(b_out.logo, "http://logo/a.png");

    set_epg(&t.conn, t.playlist, a, Some(t.source), Some("b.epg")).unwrap();
    assert_eq!(t.output().into_iter().find(|c| c.display_name == "Channel A").unwrap().logo, "http://logo/b.png");
    t.exec("UPDATE playlist_channels SET custom_logo = 'http://logo/manual.png' WHERE id = ?", [a]);
    assert_eq!(t.output().into_iter().find(|c| c.display_name == "Channel A").unwrap().logo, "http://logo/manual.png");
}

#[test]
fn removing_a_primary_promotes_its_first_alternate() {
    let t = setup();
    let (a, b, c) = three(&t);
    rename_channel(&t.conn, t.playlist, a, "BBC One").unwrap();
    make_alternates(&t.conn, t.playlist, a, &[b, c]).unwrap();
    remove_channel(&t.conn, t.playlist, a).unwrap();
    assert!(t.row(a).is_none());
    assert_eq!((t.r(b).primary_channel_id, t.r(b).custom_name.clone()), (None, None));
    assert_eq!((t.r(c).primary_channel_id, t.r(c).alt_position), (Some(b), 0));
    assert_eq!(t.output_names(), ["Channel B", "Channel B (Alt 1)"]);
}

#[test]
fn promote_alternate_keeps_the_group_name() {
    let t = setup();
    let (a, b, c) = three(&t);
    rename_channel(&t.conn, t.playlist, a, "BBC One").unwrap();
    make_alternates(&t.conn, t.playlist, a, &[b, c]).unwrap();
    promote_alternate(&t.conn, t.playlist, b).unwrap();
    assert_eq!((t.r(b).primary_channel_id, t.r(b).custom_name.as_deref()), (None, Some("BBC One")));
    assert_eq!((t.r(a).primary_channel_id, t.r(a).custom_name.clone()), (Some(b), None));
    assert_eq!(t.output_names(), ["BBC One", "BBC One (Alt 1)", "BBC One (Alt 2)"]);
}

#[test]
fn removing_a_whole_group_at_once() {
    let t = setup();
    let (a, b, c) = three(&t);
    make_alternates(&t.conn, t.playlist, a, &[b, c]).unwrap();
    bulk_remove(&t.conn, t.playlist, &[a, b, c]).unwrap();
    let n: i64 = t.conn.query_row("SELECT count(*) FROM playlist_channels", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

#[test]
fn disabling_a_source_drops_its_channels_from_output() {
    let t = setup();
    t.seed(&["Channel A"]);
    assert_eq!(t.output_names(), ["Channel A"]);
    t.exec("UPDATE sources SET enabled = 0", []);
    assert!(t.output().is_empty());
    t.exec("UPDATE sources SET enabled = 1", []);
    assert_eq!(t.output_names(), ["Channel A"]);
}

// Sorting by name

#[test]
fn bulk_sort_cases() {
    let t = setup();
    let us = t.add_category(t.playlist, "US", 1);
    let ids = t.seed(&["Charlie", "Alpha", "Bravo"]);
    bulk_sort(&t.conn, t.playlist, &ids, false).unwrap();
    assert_eq!(t.names_in_order(t.category), ["Alpha", "Bravo", "Charlie"]);
    bulk_sort(&t.conn, t.playlist, &ids, true).unwrap();
    assert_eq!(t.names_in_order(t.category), ["Charlie", "Bravo", "Alpha"]);

    let espn = t.seed_in(t.playlist, us, &["ESPN 2", "ESPN 10", "ESPN 1"]);
    bulk_sort(&t.conn, t.playlist, &espn, false).unwrap();
    assert_eq!(t.names_in_order(us), ["ESPN 1", "ESPN 2", "ESPN 10"]);
}

#[test]
fn bulk_sort_only_moves_selected_channels() {
    let t = setup();
    let ids = t.seed(&["Delta", "Alpha", "Charlie", "Bravo"]);
    bulk_sort(&t.conn, t.playlist, &[ids[0], ids[2]], false).unwrap();
    assert_eq!(t.names_in_order(t.category), ["Charlie", "Alpha", "Delta", "Bravo"]);
}

#[test]
fn bulk_sort_uses_custom_names_and_skips_alternates() {
    let t = setup();
    let ab = t.seed(&["Alpha", "Bravo"]);
    rename_channel(&t.conn, t.playlist, ab[0], "Zulu").unwrap();
    bulk_sort(&t.conn, t.playlist, &ab, false).unwrap();
    assert_eq!(t.names_in_order(t.category), ["Bravo", "Zulu"]);

    let t = setup();
    let ids = t.seed(&["Alpha", "Bravo", "Charlie"]);
    make_alternates(&t.conn, t.playlist, ids[0], &[ids[2]]).unwrap();
    bulk_sort(&t.conn, t.playlist, &ids, true).unwrap();
    assert_eq!(t.names_in_order(t.category), ["Bravo", "Alpha", "Charlie"]);
}

#[test]
fn natural_compare_ignores_case_and_reads_numbers() {
    use std::cmp::Ordering::*;
    assert_eq!(natural_compare("ESPN 2", "ESPN 10"), Less);
    assert_eq!(natural_compare("alpha", "Alpha"), Equal);
    assert_eq!(natural_compare("Écran", "ecran"), Equal);
}

// Auto-disable after failing probes

impl T {
    fn sc_probe(&self, stream: &str, status: Option<&str>, failures: i64) -> i64 {
        let id = self.sc(stream, stream);
        self.exec(
            "UPDATE source_channels SET probe_status = ?, consecutive_probe_failures = ? WHERE id = ?",
            params![status, failures, id],
        );
        id
    }

    fn add(&self, scs: &[i64]) -> Vec<i64> {
        add_channels(&self.conn, self.playlist, self.category, scs, None).unwrap();
        scs.iter().map(|sc| self.pc_for(self.playlist, self.category, *sc)).collect()
    }
}

#[test]
fn auto_disable_at_the_threshold() {
    let t = setup();
    let a = t.sc_probe("a", Some("error"), 3);
    let b = t.sc_probe("b", Some("error"), 2);
    let pcs = t.add(&[a, b]);
    auto_disable_failed_channels(&t.conn, &[a, b]).unwrap();
    assert!(!t.r(pcs[0]).enabled);
    assert!(t.r(pcs[0]).auto_disabled_at.is_some());
    assert!(t.r(pcs[1]).enabled);

    // Switching it back on clears the marker and the streak.
    toggle_channel(&t.conn, t.playlist, pcs[0], true).unwrap();
    assert!(t.r(pcs[0]).enabled);
    assert_eq!(t.r(pcs[0]).auto_disabled_at, None);
    let f: i64 = t.conn.query_row("SELECT consecutive_probe_failures FROM source_channels WHERE id = ?", [a], |r| r.get(0)).unwrap();
    assert_eq!(f, 0);
}

#[test]
fn auto_disable_skips_switched_off_sources_and_playlists_with_it_off() {
    let t = setup();
    let a = t.sc_probe("a", Some("error"), 9);
    let pc = t.add(&[a])[0];
    t.exec("UPDATE sources SET enabled = 0", []);
    auto_disable_failed_channels(&t.conn, &[a]).unwrap();
    assert!(t.r(pc).enabled);
    assert_eq!(t.r(pc).auto_disabled_at, None);

    t.exec("UPDATE sources SET enabled = 1", []);
    t.exec("UPDATE playlists SET auto_disable_failed_probes_after = 0", []);
    auto_disable_failed_channels(&t.conn, &[a]).unwrap();
    assert!(t.r(pc).enabled);
}

#[test]
fn auto_disable_hands_a_failing_primary_to_a_working_alternate() {
    let t = setup();
    let a = t.sc_probe("a", Some("error"), 3);
    let b = t.sc_probe("b", Some("ok"), 0);
    let pcs = t.add(&[a, b]);
    make_alternates(&t.conn, t.playlist, pcs[0], &[pcs[1]]).unwrap();
    auto_disable_failed_channels(&t.conn, &[a, b]).unwrap();
    assert_eq!((t.r(pcs[1]).primary_channel_id, t.r(pcs[1]).enabled), (None, true));
    assert_eq!((t.r(pcs[0]).primary_channel_id, t.r(pcs[0]).enabled), (Some(pcs[1]), false));
    assert!(t.r(pcs[0]).auto_disabled_at.is_some());
}

#[test]
fn auto_disable_with_no_working_alternate() {
    let t = setup();
    let a = t.sc_probe("a", Some("error"), 3);
    let b = t.sc_probe("b", Some("error"), 3);
    let pcs = t.add(&[a, b]);
    make_alternates(&t.conn, t.playlist, pcs[0], &[pcs[1]]).unwrap();
    auto_disable_failed_channels(&t.conn, &[a, b]).unwrap();
    assert_eq!(t.r(pcs[0]).primary_channel_id, None);
    assert!(!t.r(pcs[0]).enabled);
    assert!(!t.r(pcs[1]).enabled);
}

#[test]
fn revive_recovered_channels_cases() {
    let t = setup();
    let a = t.sc_probe("a", Some("error"), 3);
    let pc = t.add(&[a])[0];
    let pl2 = t.add_playlist("tok2");
    let cat2 = t.add_category(pl2, "UK", 0);
    add_channels(&t.conn, pl2, cat2, &[a], None).unwrap();
    let pc2 = t.pc_for(pl2, cat2, a);
    auto_disable_failed_channels(&t.conn, &[a]).unwrap();
    assert!(!t.r(pc).enabled && !t.r(pc2).enabled);

    // Still failing, so it stays off.
    revive_recovered_channels(&t.conn, &[a]).unwrap();
    assert!(!t.r(pc).enabled);
    assert!(t.r(pc).auto_disabled_at.is_some());

    t.exec("UPDATE source_channels SET probe_status = 'ok' WHERE id = ?", [a]);
    revive_recovered_channels(&t.conn, &[a]).unwrap();
    assert!(t.r(pc).enabled && t.r(pc2).enabled);
    assert_eq!((t.r(pc).auto_disabled_at, t.r(pc2).auto_disabled_at), (None, None));

    // Switched off by hand, so there's no marker and it stays off.
    let b = t.sc_probe("b", Some("ok"), 0);
    let pcb = t.add(&[b])[0];
    toggle_channel(&t.conn, t.playlist, pcb, false).unwrap();
    revive_recovered_channels(&t.conn, &[b]).unwrap();
    assert!(!t.r(pcb).enabled);
}

// Smart sort applied to a group

impl T {
    #[allow(clippy::too_many_arguments)]
    fn sc_quality(&self, source: i64, stream: &str, status: &str, h: i64, vcodec: &str, acodec: &str, kbps: i64) -> i64 {
        let id = test_support::source_channel(&self.conn, source, stream, stream, "UK");
        self.exec(
            "UPDATE source_channels SET probe_status = ?, probe_height = ?, probe_fps = 50, probe_video_codec = ?, \
               probe_audio_codec = ?, probe_bitrate = ? WHERE id = ?",
            params![status, h, vcodec, acodec, kbps, id],
        );
        id
    }
}

#[test]
fn smart_sort_group_promotes_the_best_and_keeps_name_and_guide() {
    let t = setup();
    let a = t.sc_quality(t.source, "a", "ok", 1080, "h264", "aac", 6000);
    let b = t.sc_quality(t.source, "b", "ok", 1080, "h264", "eac3", 12000);
    let pcs = t.add(&[a, b]);
    rename_channel(&t.conn, t.playlist, pcs[0], "Sky Sports").unwrap();
    set_epg(&t.conn, t.playlist, pcs[0], Some(t.source), Some("custom.epg")).unwrap();
    make_alternates(&t.conn, t.playlist, pcs[0], &[pcs[1]]).unwrap();
    smart_sort_group(&t.conn, t.playlist, pcs[0], &SmartSortConfig::default()).unwrap();
    let (np, op) = (t.r(pcs[1]), t.r(pcs[0]));
    assert_eq!(np.primary_channel_id, None);
    assert_eq!(np.custom_name.as_deref(), Some("Sky Sports"));
    assert_eq!(np.epg_channel_id.as_deref(), Some("custom.epg"));
    assert_eq!((op.primary_channel_id, op.alt_position, op.custom_name), (Some(pcs[1]), 0, None));
}

#[test]
fn smart_sort_group_reorders_alternates_when_the_primary_is_best() {
    let t = setup();
    let a = t.sc_quality(t.source, "a", "ok", 1080, "h264", "eac3", 12000);
    let b = t.sc_quality(t.source, "b", "ok", 1080, "h264", "aac", 5000);
    let c = t.sc_quality(t.source, "c", "ok", 1080, "h264", "aac", 8000);
    let pcs = t.add(&[a, b, c]);
    make_alternates(&t.conn, t.playlist, pcs[0], &[pcs[1], pcs[2]]).unwrap();
    smart_sort_group(&t.conn, t.playlist, pcs[0], &SmartSortConfig::default()).unwrap();
    assert_eq!(t.r(pcs[0]).primary_channel_id, None);
    assert_eq!(t.r(pcs[2]).alt_position, 0);
    assert_eq!(t.r(pcs[1]).alt_position, 1);
}

#[test]
fn smart_sort_group_keeps_auto_disabled_and_switched_off_streams_out_of_front() {
    let t = setup();
    let a = t.sc_quality(t.source, "a", "ok", 1080, "h264", "aac", 6000);
    let b = t.sc_quality(t.source, "b", "error", 2160, "hevc", "eac3", 20000);
    let pcs = t.add(&[a, b]);
    make_alternates(&t.conn, t.playlist, pcs[0], &[pcs[1]]).unwrap();
    t.exec("UPDATE playlist_channels SET enabled = 0, auto_disabled_at = 0 WHERE id = ?", [pcs[1]]);
    smart_sort_group(&t.conn, t.playlist, pcs[0], &SmartSortConfig::default()).unwrap();
    assert_eq!(t.r(pcs[0]).primary_channel_id, None);

    let t = setup();
    let off = test_support::source(&t.conn, "Off");
    t.exec("UPDATE sources SET enabled = 0 WHERE id = ?", [off]);
    let a = t.sc_quality(t.source, "a", "ok", 1080, "h264", "aac", 6000);
    let b = t.sc_quality(off, "b", "ok", 2160, "hevc", "eac3", 20000);
    let pcs = t.add(&[a, b]);
    make_alternates(&t.conn, t.playlist, pcs[0], &[pcs[1]]).unwrap();
    smart_sort_group(&t.conn, t.playlist, pcs[0], &SmartSortConfig::default()).unwrap();
    assert_eq!(t.r(pcs[0]).primary_channel_id, None);
    assert_eq!(t.r(pcs[1]).alt_position, 0);
}
