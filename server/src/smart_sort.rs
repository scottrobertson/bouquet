//! Orders an alternate group's streams best-first from probe data. More pixels
//! and more frames are plainly better, and for a given codec more bitrate means
//! less compression. Codecs differ in efficiency, so bitrate is converted to a
//! rough h264 equivalent before comparing, and bucketed so measurement noise
//! can't reorder near-identical streams. Audio and liveness only break ties.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum SmartSortPrefer {
    Resolution,
    Bitrate,
}

impl SmartSortPrefer {
    pub fn parse(s: &str) -> SmartSortPrefer {
        if s == "bitrate" { SmartSortPrefer::Bitrate } else { SmartSortPrefer::Resolution }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SmartSortConfig {
    // The top quality signal: the resolution bucket or the normalised bitrate.
    pub prefer: SmartSortPrefer,
    // Let the audio codec break ties, surround over stereo.
    pub audio: bool,
    // Put working streams above never-probed ones, and both above dead ones.
    pub available_first: bool,
}

impl Default for SmartSortConfig {
    fn default() -> Self {
        SmartSortConfig { prefer: SmartSortPrefer::Resolution, audio: true, available_first: true }
    }
}

/// The fields the sort reads.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SmartSortStream {
    pub available: bool,
    // A switched-off source keeps the channel out of output, so it can't be a
    // sensible primary.
    pub source_enabled: bool,
    pub auto_disabled: bool,
    pub probe_status: Option<String>,
    pub probe_width: Option<i64>,
    pub probe_height: Option<i64>,
    pub probe_fps: Option<f64>,
    pub probe_video_codec: Option<String>,
    pub probe_audio_codec: Option<String>,
    pub probe_bitrate: Option<i64>,
}

/// Newer codecs give the same picture at a lower bitrate. The factors are
/// ballpark, which is why the result is only compared in coarse buckets.
pub const CODEC_EFFICIENCY_TABLE: &[(&str, &[&str], f64)] = &[
    ("AV1", &["av1"], 2.0),
    ("HEVC / H.265 / VP9", &["h265", "hevc", "vp9"], 1.7),
    ("H.264", &["h264", "avc"], 1.0),
    ("MPEG-2", &["mpeg2", "mpeg2video"], 0.5),
];

// Bitrate is a measured estimate, so anything within half a Mbps counts as equal.
const BITRATE_BUCKET_KBPS: f64 = 500.0;

fn codec_factor(codec: Option<&str>) -> f64 {
    let Some(codec) = codec else { return 1.0 };
    let codec = codec.to_lowercase();
    CODEC_EFFICIENCY_TABLE
        .iter()
        .find(|(_, codecs, _)| codecs.contains(&codec.as_str()))
        .map(|(_, _, f)| *f)
        .unwrap_or(1.0)
}

fn audio_rank_of(codec: &str) -> f64 {
    match codec.to_lowercase().as_str() {
        "truehd" => 4.0,
        "eac3" | "ac3" | "dts" => 3.0,
        "aac" => 2.0,
        _ => 1.0,
    }
}

// A channel waiting to be probed can still carry numbers from an earlier run.
// The editor hides those as "No probe data", so the sort ignores them too.
fn measured(s: &SmartSortStream) -> bool {
    s.probe_status.as_deref() == Some("ok")
}

fn raw_bitrate(s: &SmartSortStream) -> Option<i64> {
    match s.probe_bitrate {
        Some(b) if measured(s) && b > 0 => Some(b),
        _ => None,
    }
}

fn effective_bitrate(s: &SmartSortStream) -> f64 {
    match raw_bitrate(s) {
        Some(raw) => (raw as f64 * codec_factor(s.probe_video_codec.as_deref()) / BITRATE_BUCKET_KBPS).round(),
        None => 0.0,
    }
}

// Coarse rank by height, so 1920x1080 and 1916x1080 tie.
fn resolution_rank(s: &SmartSortStream) -> f64 {
    let h = if measured(s) { s.probe_height.unwrap_or(0) } else { 0 };
    match h {
        h if h >= 4320 => 5.0,
        h if h >= 2160 => 4.0,
        h if h >= 1080 => 3.0,
        h if h >= 720 => 2.0,
        h if h > 0 => 1.0,
        _ => 0.0,
    }
}

// 50/60 fps reads as smoother, which matters most for sport.
fn fps_rank(s: &SmartSortStream) -> f64 {
    let f = if measured(s) { s.probe_fps.unwrap_or(0.0) } else { 0.0 };
    if f >= 48.0 {
        2.0
    } else if f >= 24.0 {
        1.0
    } else if f > 0.0 {
        0.5
    } else {
        0.0
    }
}

fn audio_rank(s: &SmartSortStream) -> f64 {
    match &s.probe_audio_codec {
        Some(c) if measured(s) => audio_rank_of(c),
        _ => 0.0,
    }
}

/// Working first, then never probed (might be fine), then a failed probe, then
/// gone from the provider, then auto-disabled, then a switched-off source.
/// A switched-off source sits lowest because the user turned it off, whereas
/// an auto-disabled channel comes back on its own once a probe passes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum Liveness {
    Working,
    Unprobed,
    Failed,
    Unavailable,
    AutoDisabled,
    SourceOff,
}

impl Liveness {
    fn rank(self) -> f64 {
        match self {
            Liveness::Working => 5.0,
            Liveness::Unprobed => 4.0,
            Liveness::Failed => 3.0,
            Liveness::Unavailable => 2.0,
            Liveness::AutoDisabled => 1.0,
            Liveness::SourceOff => 0.0,
        }
    }
}

fn liveness(s: &SmartSortStream) -> Liveness {
    if !s.source_enabled {
        return Liveness::SourceOff;
    }
    if s.auto_disabled {
        return Liveness::AutoDisabled;
    }
    if !s.available {
        return Liveness::Unavailable;
    }
    match s.probe_status.as_deref() {
        Some("error") | Some("timeout") => Liveness::Failed,
        Some("ok") => Liveness::Working,
        _ => Liveness::Unprobed,
    }
}

// Comparison keys, all higher-is-better. The first key that differs decides.
fn sort_keys(s: &SmartSortStream, config: &SmartSortConfig) -> Vec<f64> {
    let mut keys = Vec::with_capacity(6);
    if config.available_first {
        keys.push(liveness(s).rank());
    }
    let (res, fps, bitrate) = (resolution_rank(s), fps_rank(s), effective_bitrate(s));
    match config.prefer {
        SmartSortPrefer::Bitrate => keys.extend([bitrate, res, fps]),
        SmartSortPrefer::Resolution => keys.extend([res, fps, bitrate]),
    }
    if config.audio {
        keys.push(audio_rank(s));
    }
    // Streams that land in the same bucket still order by their real numbers.
    keys.push(raw_bitrate(s).unwrap_or(0) as f64);
    keys
}

/// Indices of `streams` best-first. Ties keep their input order.
pub fn smart_sort_order(streams: &[SmartSortStream], config: &SmartSortConfig) -> Vec<usize> {
    let keys: Vec<Vec<f64>> = streams.iter().map(|s| sort_keys(s, config)).collect();
    let mut order: Vec<usize> = (0..streams.len()).collect();
    // sort_by is stable, so equal streams keep their current order.
    order.sort_by(|&a, &b| {
        keys[b].partial_cmp(&keys[a]).unwrap_or(std::cmp::Ordering::Equal)
    });
    order
}

/// Whether smart sort would change this group. Members go in their current
/// order, primary first.
pub fn needs_smart_sort(members: &[SmartSortStream], config: &SmartSortConfig) -> bool {
    members.len() >= 2 && smart_sort_order(members, config).iter().enumerate().any(|(i, &j)| i != j)
}

/// The values that fed the sort, so the preview can show why a stream ranks
/// where it does.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SmartSortFactors {
    pub liveness: Liveness,
    pub resolution_rank: f64,
    pub fps_rank: f64,
    pub raw_bitrate_kbps: Option<i64>,
    // The h264-equivalent bitrate before bucketing. Differs from the raw one
    // only when the codec got an efficiency credit.
    pub normalised_bitrate_kbps: Option<i64>,
    pub audio_rank: f64,
    pub codec_adjusted: bool,
}

pub fn factors_for(s: &SmartSortStream) -> SmartSortFactors {
    let factor = codec_factor(s.probe_video_codec.as_deref());
    let raw = raw_bitrate(s);
    SmartSortFactors {
        liveness: liveness(s),
        resolution_rank: resolution_rank(s),
        fps_rank: fps_rank(s),
        raw_bitrate_kbps: raw,
        normalised_bitrate_kbps: raw.map(|r| (r as f64 * factor).round() as i64),
        audio_rank: audio_rank(s),
        codec_adjusted: factor != 1.0 && raw.is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEFAULT: SmartSortConfig =
        SmartSortConfig { prefer: SmartSortPrefer::Resolution, audio: true, available_first: true };

    fn stream(height: i64, fps: f64, vcodec: &str, acodec: &str, mbps: f64) -> SmartSortStream {
        SmartSortStream {
            available: true,
            source_enabled: true,
            auto_disabled: false,
            probe_status: Some("ok".into()),
            probe_width: Some((height as f64 * 16.0 / 9.0).round() as i64),
            probe_height: Some(height),
            probe_fps: Some(fps),
            probe_video_codec: Some(vcodec.into()),
            probe_audio_codec: Some(acodec.into()),
            probe_bitrate: Some((mbps * 1000.0).round() as i64),
        }
    }

    fn with_status(mut s: SmartSortStream, status: Option<&str>) -> SmartSortStream {
        s.probe_status = status.map(String::from);
        s
    }

    fn names<'a>(list: &[(&'a str, SmartSortStream)], config: &SmartSortConfig) -> Vec<&'a str> {
        let streams: Vec<_> = list.iter().map(|(_, s)| s.clone()).collect();
        smart_sort_order(&streams, config).into_iter().map(|i| list[i].0).collect()
    }

    fn tnt() -> Vec<(&'static str, SmartSortStream)> {
        vec![
            ("primary", stream(1080, 50.0, "h264", "aac", 7.5)),
            ("alt1", stream(1080, 50.0, "h264", "eac3", 9.9)),
            ("alt2", stream(1080, 50.0, "h264", "aac", 6.2)),
            ("alt3", stream(1080, 50.0, "hevc", "aac", 2.7)),
            ("alt4", stream(1080, 50.0, "h264", "aac", 6.9)),
            ("alt5", stream(1080, 50.0, "h264", "eac3", 7.4)),
        ]
    }

    #[test]
    fn orders_the_tnt_group_best_first() {
        assert_eq!(names(&tnt(), &DEFAULT), ["alt1", "alt5", "primary", "alt4", "alt2", "alt3"]);
    }

    #[test]
    fn raw_bitrate_is_the_final_tiebreaker_when_audio_is_off() {
        let order = names(&tnt(), &SmartSortConfig { audio: false, ..DEFAULT });
        let pos = |n| order.iter().position(|x| *x == n).unwrap();
        assert!(pos("primary") < pos("alt5"));
    }

    #[test]
    fn hevc_bitrate_is_normalised() {
        let pair = [("hevc", stream(1080, 50.0, "hevc", "aac", 5.0)), ("h264", stream(1080, 50.0, "h264", "aac", 7.0))];
        assert_eq!(names(&pair, &DEFAULT)[0], "hevc");
    }

    #[test]
    fn resolution_first_by_default_and_bitrate_first_on_request() {
        let pair = [("hd", stream(720, 50.0, "h264", "aac", 12.0)), ("fhd", stream(1080, 50.0, "h264", "aac", 6.0))];
        assert_eq!(names(&pair, &DEFAULT)[0], "fhd");
        assert_eq!(names(&pair, &SmartSortConfig { prefer: SmartSortPrefer::Bitrate, ..DEFAULT })[0], "hd");
    }

    #[test]
    fn liveness_order() {
        let mut source_off = stream(1080, 50.0, "h264", "aac", 10.0);
        source_off.source_enabled = false;
        let mut auto_disabled = stream(1080, 50.0, "h264", "aac", 10.0);
        auto_disabled.auto_disabled = true;
        let mut unavailable = stream(1080, 50.0, "h264", "aac", 10.0);
        unavailable.available = false;
        let list = [
            ("sourceOff", source_off),
            ("autoDisabled", auto_disabled),
            ("unavailable", unavailable),
            ("failed", with_status(stream(1080, 50.0, "h264", "aac", 10.0), Some("timeout"))),
            ("unprobed", with_status(stream(1080, 50.0, "h264", "aac", 10.0), None)),
            ("working", stream(720, 30.0, "h264", "aac", 2.0)),
        ];
        assert_eq!(
            names(&list, &DEFAULT),
            ["working", "unprobed", "failed", "unavailable", "autoDisabled", "sourceOff"]
        );
    }

    #[test]
    fn auto_disabled_on_a_switched_off_source_sinks_lowest() {
        let mut off = stream(1080, 50.0, "h264", "aac", 10.0);
        off.source_enabled = false;
        off.auto_disabled = true;
        let mut on = stream(1080, 50.0, "h264", "aac", 10.0);
        on.auto_disabled = true;
        assert_eq!(names(&[("offSource", off), ("onSource", on)], &DEFAULT), ["onSource", "offSource"]);
    }

    #[test]
    fn leftover_numbers_on_an_unprobed_stream_are_ignored() {
        let list = [
            ("plain", with_status(stream(1080, 50.0, "h264", "aac", 6.0), None)),
            ("stale4k", with_status(stream(2160, 50.0, "hevc", "eac3", 20.0), Some("queued"))),
        ];
        assert_eq!(names(&list, &DEFAULT), ["plain", "stale4k"]);
        let streams: Vec<_> = list.iter().map(|(_, s)| s.clone()).collect();
        assert!(!needs_smart_sort(&streams, &DEFAULT));
    }

    #[test]
    fn auto_disabled_sinks_below_plain_failed() {
        let mut auto = with_status(stream(1080, 50.0, "h264", "aac", 10.0), Some("error"));
        auto.auto_disabled = true;
        let failed = with_status(stream(1080, 50.0, "h264", "aac", 10.0), Some("error"));
        assert_eq!(names(&[("autoDisabled", auto), ("failed", failed)], &DEFAULT), ["failed", "autoDisabled"]);
    }

    #[test]
    fn quality_still_wins_with_available_first_off() {
        let mut dead = stream(720, 30.0, "h264", "aac", 3.0);
        dead.available = false;
        let list = [("dead", dead), ("working", stream(1080, 50.0, "h264", "eac3", 9.0))];
        assert_eq!(names(&list, &SmartSortConfig { available_first: false, ..DEFAULT })[0], "working");
    }

    #[test]
    fn needs_smart_sort_cases() {
        let sorted = [
            stream(1080, 50.0, "h264", "eac3", 9.0),
            stream(1080, 50.0, "h264", "aac", 6.0),
            stream(720, 25.0, "h264", "aac", 3.0),
        ];
        assert!(!needs_smart_sort(&sorted, &DEFAULT));

        let better_below = [stream(720, 25.0, "h264", "aac", 3.0), stream(1080, 50.0, "h264", "eac3", 9.0)];
        assert!(needs_smart_sort(&better_below, &DEFAULT));

        let alts_out_of_order = [
            stream(1080, 50.0, "h264", "eac3", 9.0),
            stream(720, 25.0, "h264", "aac", 3.0),
            stream(1080, 25.0, "h264", "aac", 5.0),
        ];
        assert!(needs_smart_sort(&alts_out_of_order, &DEFAULT));

        let unprobed = SmartSortStream { available: true, source_enabled: true, ..Default::default() };
        assert!(!needs_smart_sort(&[unprobed.clone(), unprobed], &DEFAULT));

        let mut dead_primary = stream(1080, 50.0, "h264", "aac", 6.0);
        dead_primary.available = false;
        let pair = [dead_primary, stream(1080, 50.0, "h264", "aac", 6.0)];
        assert!(needs_smart_sort(&pair, &DEFAULT));
        assert!(!needs_smart_sort(&pair, &SmartSortConfig { available_first: false, ..DEFAULT }));

        assert!(!needs_smart_sort(&[stream(1080, 50.0, "h264", "aac", 6.0)], &DEFAULT));
    }

    #[test]
    fn factors() {
        let f = factors_for(&stream(1080, 50.0, "hevc", "aac", 4.0));
        assert!(f.codec_adjusted);
        assert_eq!(f.raw_bitrate_kbps, Some(4000));
        assert_eq!(f.normalised_bitrate_kbps, Some(6800));

        let f = factors_for(&stream(1080, 50.0, "h264", "aac", 8.0));
        assert!(!f.codec_adjusted);
        assert_eq!(f.normalised_bitrate_kbps, Some(8000));

        let f = factors_for(&with_status(stream(1080, 50.0, "h264", "aac", 8.0), Some("queued")));
        assert_eq!(f.raw_bitrate_kbps, None);
        assert_eq!(f.resolution_rank, 0.0);
    }

    #[test]
    fn liveness_labels() {
        let s = || stream(1080, 50.0, "h264", "aac", 8.0);
        assert_eq!(factors_for(&s()).liveness, Liveness::Working);
        assert_eq!(factors_for(&SmartSortStream { available: false, ..s() }).liveness, Liveness::Unavailable);
        assert_eq!(factors_for(&with_status(s(), None)).liveness, Liveness::Unprobed);
        assert_eq!(factors_for(&with_status(s(), Some("error"))).liveness, Liveness::Failed);
        assert_eq!(
            factors_for(&SmartSortStream { auto_disabled: true, ..with_status(s(), Some("error")) }).liveness,
            Liveness::AutoDisabled
        );
        assert_eq!(factors_for(&SmartSortStream { source_enabled: false, ..s() }).liveness, Liveness::SourceOff);
        assert_eq!(
            factors_for(&SmartSortStream { source_enabled: false, auto_disabled: true, ..s() }).liveness,
            Liveness::SourceOff
        );
    }
}
