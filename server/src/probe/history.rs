//! Probe history. Each probe only sees a few seconds of a live stream, so one
//! reading can catch an off air slate, a logo card or a slow server. The probe
//! columns on a source channel are a summary of its recent probes, so one odd
//! reading can't move it around.

use anyhow::Result;
use rusqlite::{Connection, params};
use serde::Serialize;
use ts_rs::TS;

use crate::routes::api::{iso, kinds};

/// One stored probe result.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProbeSample {
    pub id: i64,
    pub probed_at: i64,
    pub status: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bitrate: Option<i64>,
    pub error: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProbeHistorySample {
    pub probed_at: String,
    #[ts(as = "kinds::ChannelProbeStatus")]
    pub status: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bitrate: Option<i64>,
    pub error: Option<String>,
    // Left out of the summary as a likely slate.
    pub ignored: bool,
}

/// A channel's probe history for the editor, oldest first.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProbeHistory {
    pub days: i64,
    pub samples: Vec<ProbeHistorySample>,
}

pub fn history(conn: &Connection, source_channel_id: i64, now: i64) -> Result<ProbeHistory> {
    let samples = samples_since(conn, source_channel_id, window_start(now))?;
    let ignored = summarise(&samples).ignored;
    Ok(ProbeHistory {
        days: crate::config::config().probe_history_days,
        samples: samples
            .into_iter()
            .map(|s| ProbeHistorySample {
                ignored: ignored.contains(&s.id),
                probed_at: iso(s.probed_at),
                status: s.status,
                width: s.width,
                height: s.height,
                fps: s.fps,
                video_codec: s.video_codec,
                audio_codec: s.audio_codec,
                bitrate: s.bitrate,
                error: s.error,
            })
            .collect(),
    })
}

/// What a source channel's probe columns hold: the typical quality across its
/// recent passing probes, and how many probes passed.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Summary {
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub bitrate: Option<i64>,
    pub passes: i64,
    pub attempts: i64,
    // Passing probes left out because their bitrate was far below the best one.
    pub ignored: Vec<i64>,
}

// A slate or logo card is a still picture, which compresses to a fraction of
// the real programme's bitrate. Readings under this share of the best one are
// treated as one of those and left out.
const LOW_BITRATE_FRACTION: f64 = 0.4;

// The value seen most often, with the newest winning a tie. Values come oldest
// first.
fn most_common<T: PartialEq + Clone>(values: &[T]) -> Option<T> {
    let mut best: Option<(usize, &T)> = None;
    for v in values {
        let count = values.iter().filter(|x| *x == v).count();
        if best.is_none_or(|(n, _)| count >= n) {
            best = Some((count, v));
        }
    }
    best.map(|(_, v)| v.clone())
}

/// Summarise a channel's samples, oldest first.
pub fn summarise(samples: &[ProbeSample]) -> Summary {
    let ok: Vec<&ProbeSample> = samples.iter().filter(|s| s.status == "ok").collect();
    let best = ok.iter().filter_map(|s| s.bitrate).filter(|b| *b > 0).max();
    let is_low = |s: &ProbeSample| match (s.bitrate, best) {
        (Some(b), Some(best)) => (b as f64) < best as f64 * LOW_BITRATE_FRACTION,
        _ => false,
    };
    let (ignored, kept): (Vec<&ProbeSample>, Vec<&ProbeSample>) = ok.iter().partition(|s| is_low(s));

    let mut bitrates: Vec<i64> = kept.iter().filter_map(|s| s.bitrate).filter(|b| *b > 0).collect();
    bitrates.sort();
    // The upper middle for an even count, so a lone low reading can't drag a
    // two probe history down.
    let bitrate = bitrates.get(bitrates.len() / 2).copied();

    let resolution = most_common(&kept.iter().map(|s| (s.width, s.height)).collect::<Vec<_>>());
    let (width, height) = resolution.unwrap_or_default();
    Summary {
        width,
        height,
        fps: most_common(&kept.iter().map(|s| s.fps).collect::<Vec<_>>()).flatten(),
        video_codec: most_common(&kept.iter().map(|s| s.video_codec.clone()).collect::<Vec<_>>()).flatten(),
        audio_codec: most_common(&kept.iter().map(|s| s.audio_codec.clone()).collect::<Vec<_>>()).flatten(),
        bitrate,
        passes: ok.len() as i64,
        attempts: samples.len() as i64,
        ignored: ignored.iter().map(|s| s.id).collect(),
    }
}

/// The oldest probe time still inside the history window.
pub fn window_start(now: i64) -> i64 {
    now - crate::config::config().probe_history_days * 86_400
}

/// A channel's samples inside the history window, oldest first.
pub fn samples_since(conn: &Connection, source_channel_id: i64, since: i64) -> Result<Vec<ProbeSample>> {
    let mut stmt = conn.prepare(
        "SELECT id, probed_at, status, width, height, fps, video_codec, audio_codec, bitrate, error FROM probe_samples \
         WHERE source_channel_id = ? AND probed_at >= ? ORDER BY probed_at, id",
    )?;
    let rows = stmt.query_map(params![source_channel_id, since], |r| {
        Ok(ProbeSample {
            id: r.get(0)?,
            probed_at: r.get(1)?,
            status: r.get(2)?,
            width: r.get(3)?,
            height: r.get(4)?,
            fps: r.get(5)?,
            video_codec: r.get(6)?,
            audio_codec: r.get(7)?,
            bitrate: r.get(8)?,
            error: r.get(9)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Store a probe result and rewrite the channel's probe columns from its
/// history. The status and error are always this probe's own.
pub fn record(conn: &Connection, source_channel_id: i64, sample: &ProbeSample) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO probe_samples (source_channel_id, probed_at, status, width, height, fps, video_codec, audio_codec, bitrate, error) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params![
            source_channel_id,
            sample.probed_at,
            sample.status,
            sample.width,
            sample.height,
            sample.fps,
            sample.video_codec,
            sample.audio_codec,
            sample.bitrate,
            sample.error
        ],
    )?;
    let s = summarise(&samples_since(&tx, source_channel_id, window_start(sample.probed_at))?);
    let ok = sample.status == "ok";
    tx.execute(
        "UPDATE source_channels SET probed_at = ?, probe_status = ?, probe_error = ?, probe_width = ?, probe_height = ?, \
           probe_fps = ?, probe_video_codec = ?, probe_audio_codec = ?, probe_bitrate = ?, probe_passes = ?, probe_attempts = ?, \
           consecutive_probe_failures = CASE WHEN ? THEN 0 ELSE consecutive_probe_failures + 1 END \
         WHERE id = ?",
        params![
            sample.probed_at,
            sample.status,
            sample.error,
            s.width,
            s.height,
            s.fps,
            s.video_codec,
            s.audio_codec,
            s.bitrate,
            s.passes,
            s.attempts,
            ok,
            source_channel_id
        ],
    )?;
    tx.commit()?;
    Ok(())
}

/// Drop samples older than the history window.
pub fn prune(conn: &Connection, now: i64) -> Result<usize> {
    Ok(conn.execute("DELETE FROM probe_samples WHERE probed_at < ?", [window_start(now)])?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support;

    fn ok(id: i64, height: i64, kbps: i64) -> ProbeSample {
        ProbeSample {
            id,
            probed_at: id,
            status: "ok".into(),
            width: Some(height * 16 / 9),
            height: Some(height),
            fps: Some(50.0),
            video_codec: Some("h264".into()),
            audio_codec: Some("aac".into()),
            bitrate: Some(kbps),
            error: None,
        }
    }

    fn failed(id: i64) -> ProbeSample {
        ProbeSample { id, probed_at: id, status: "timeout".into(), error: Some("Probe timed out".into()), ..Default::default() }
    }

    #[test]
    fn slate_readings_are_ignored() {
        let s = summarise(&[ok(1, 1080, 6000), ok(2, 1080, 400), ok(3, 1080, 6400), ok(4, 576, 300), ok(5, 1080, 5800)]);
        assert_eq!(s.bitrate, Some(6000));
        assert_eq!(s.height, Some(1080));
        assert_eq!(s.ignored, [2, 4]);
        assert_eq!((s.passes, s.attempts), (5, 5));
    }

    #[test]
    fn two_readings_lean_high() {
        assert_eq!(summarise(&[ok(1, 1080, 5000), ok(2, 1080, 7000)]).bitrate, Some(7000));
        assert_eq!(summarise(&[ok(1, 1080, 6000)]).bitrate, Some(6000));
    }

    #[test]
    fn failures_count_but_keep_the_numbers() {
        let s = summarise(&[ok(1, 1080, 6000), failed(2), ok(3, 1080, 6200), failed(4)]);
        assert_eq!(s.bitrate, Some(6200));
        assert_eq!(s.height, Some(1080));
        assert_eq!((s.passes, s.attempts), (2, 4));

        let s = summarise(&[failed(1), failed(2)]);
        assert_eq!((s.bitrate, s.height, s.video_codec), (None, None, None));
        assert_eq!((s.passes, s.attempts), (0, 2));
    }

    #[test]
    fn newest_resolution_wins_a_tie() {
        let s = summarise(&[ok(1, 720, 3000), ok(2, 1080, 3000)]);
        assert_eq!(s.height, Some(1080));
        let s = summarise(&[ok(1, 1080, 3000), ok(2, 720, 3000), ok(3, 1080, 3000), ok(4, 720, 3000), ok(5, 1080, 3000)]);
        assert_eq!(s.height, Some(1080));
    }

    #[test]
    fn no_bitrate_reported_still_summarises() {
        let s = summarise(&[ProbeSample { bitrate: None, ..ok(1, 1080, 0) }]);
        assert_eq!((s.bitrate, s.height), (None, Some(1080)));
        assert!(s.ignored.is_empty());
    }

    #[test]
    fn record_rewrites_the_channel_from_its_history_and_prune_drops_old_samples() {
        let db = test_support::db();
        let conn = db.lock();
        let source = test_support::source(&conn, "Main");
        let id = test_support::source_channel(&conn, source, "a", "A", "UK");
        let day = 86_400;
        record(&conn, id, &ProbeSample { probed_at: day, ..ok(0, 1080, 6000) }).unwrap();
        record(&conn, id, &ProbeSample { probed_at: 2 * day, ..ok(0, 1080, 300) }).unwrap();
        record(&conn, id, &ProbeSample { probed_at: 3 * day, ..failed(0) }).unwrap();
        let row: (String, Option<i64>, i64, i64, i64) = conn
            .query_row(
                "SELECT probe_status, probe_bitrate, probe_passes, probe_attempts, consecutive_probe_failures \
                 FROM source_channels WHERE id = ?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(row, ("timeout".into(), Some(6000), 2, 3, 1));

        assert_eq!(prune(&conn, 9 * day + day / 2).unwrap(), 2);
        assert_eq!(samples_since(&conn, id, 0).unwrap().len(), 1);
    }
}
