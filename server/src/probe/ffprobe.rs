//! Reads a stream once with ffmpeg and hands a copy to ffprobe, so a single
//! connection to the provider gives us the stream's quality, its real bitrate
//! and, when asked, whether the picture is black or frozen.

use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::config::config;
use crate::quality::clean_probe_error;

// ffmpeg 7+ rejects HLS segments with unusual or missing extensions, which
// breaks m3u8 streams from providers that redirect to odd segment URLs.
fn hls_relax_args(hls: bool) -> &'static [&'static str] {
    if hls { &["-extension_picky", "0"] } else { &[] }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Quality {
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<f64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    // The video track's bitrate in kbps, from the packets we read.
    pub bitrate: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProbeResult {
    pub status: &'static str,
    pub quality: Quality,
    pub error: Option<String>,
    // The picture didn't move, like a logo card shown while a channel is off
    // air. The stream works, but its numbers say nothing about the programme.
    pub off_air: bool,
}

impl ProbeResult {
    fn failed(status: &'static str, error: impl Into<String>) -> ProbeResult {
        ProbeResult { status, quality: Quality::default(), error: Some(error.into()), off_air: false }
    }
}

// Frame rate comes back as a fraction like "50/1" or "30000/1001".
fn parse_frame_rate(value: Option<&Value>) -> Option<f64> {
    let s = value?.as_str()?;
    let mut parts = s.split('/');
    let num: f64 = parts.next()?.trim().parse().ok()?;
    let den: f64 = parts.next().map(|d| d.trim().parse().ok()).unwrap_or(Some(f64::NAN))?;
    if !num.is_finite() || !den.is_finite() || den == 0.0 {
        return None;
    }
    let fps = num / den;
    // Two decimals, so 29.97 stays 29.97 and 25.0 reads as 25.
    (fps > 0.0).then(|| (fps * 100.0).round() / 100.0)
}

fn positive_int(value: Option<&Value>) -> Option<i64> {
    let n = crate::js::number(value);
    (n.is_finite() && n > 0.0).then(|| n.trunc() as i64)
}

/// kbps of the video packets, over the time their timestamps span. Counting
/// only video keeps extra audio tracks and padding out of the comparison.
fn video_bitrate(packets: &[Value], video_index: i64, fps: Option<f64>) -> Option<i64> {
    let mut bytes = 0.0;
    let (mut first, mut last) = (f64::INFINITY, f64::NEG_INFINITY);
    for p in packets.iter().filter(|p| p.get("stream_index").and_then(|i| i.as_i64()) == Some(video_index)) {
        bytes += crate::js::number(p.get("size"));
        let pts = crate::js::number(p.get("pts_time"));
        if pts.is_finite() {
            first = first.min(pts);
            last = last.max(pts);
        }
    }
    // The last frame still plays for one frame's time after its timestamp.
    let seconds = last - first + fps.map(|f| 1.0 / f).unwrap_or(0.0);
    (bytes > 0.0 && seconds.is_finite() && seconds > 0.0).then(|| (bytes * 8.0 / seconds / 1000.0).round() as i64)
}

/// The fields we store from ffprobe's JSON.
pub fn parse_ffprobe(json: &Value) -> Quality {
    let Some(streams) = json.get("streams").and_then(|s| s.as_array()) else { return Quality::default() };
    let of_type = |t: &str| streams.iter().find(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some(t));
    let video = of_type("video");
    let audio = of_type("audio");
    let codec = |s: Option<&Value>| s.and_then(|s| s.get("codec_name")).and_then(|c| c.as_str()).map(String::from);
    let fps = parse_frame_rate(video.and_then(|v| v.get("avg_frame_rate")))
        .or_else(|| parse_frame_rate(video.and_then(|v| v.get("r_frame_rate"))));
    let packets = json.get("packets").and_then(|p| p.as_array()).map(Vec::as_slice).unwrap_or_default();
    let video_index = video.and_then(|v| v.get("index")).and_then(|i| i.as_i64());
    Quality {
        width: positive_int(video.and_then(|v| v.get("width"))),
        height: positive_int(video.and_then(|v| v.get("height"))),
        fps,
        video_codec: codec(video),
        audio_codec: codec(audio),
        bitrate: video_index.and_then(|i| video_bitrate(packets, i, fps)),
    }
}

// Black or frozen frames have to cover this much of what was decoded. High, so
// fades, ad breaks and slow scenes don't trip it.
const STILL_FRACTION: f64 = 0.9;

static BLACK_DURATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"black_duration:([\d.]+)").unwrap());
static FREEZE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"freezedetect\.freeze_(start|end): ([\d.]+)").unwrap());
static DECODE_TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"time=(\d+:\d+:\d+\.\d+)").unwrap());

// HH:MM:SS.ss in seconds.
fn parse_timestamp(value: &str) -> f64 {
    let parts: Vec<f64> = value.split(':').map(|p| p.parse().unwrap_or(f64::NAN)).collect();
    match parts.as_slice() {
        [h, m, s] if parts.iter().all(|p| p.is_finite()) => h * 3600.0 + m * 60.0 + s,
        _ => 0.0,
    }
}

fn decoded_seconds(stderr: &str) -> f64 {
    DECODE_TIME.captures_iter(stderr).map(|c| parse_timestamp(&c[1])).fold(0.0, f64::max)
}

// Too little decoded counts as inconclusive, so a stream that stalls early
// isn't judged on a second of video.
fn mostly(still: f64, decoded: f64, window: f64) -> bool {
    decoded >= window.min(1.0) && still / decoded >= STILL_FRACTION
}

/// Whether blackdetect's output means the picture was all black.
pub fn parse_blackdetect(stderr: &str, window: f64) -> bool {
    let black: f64 = BLACK_DURATION.captures_iter(stderr).map(|c| c[1].parse::<f64>().unwrap_or(0.0)).sum();
    mostly(black, decoded_seconds(stderr), window)
}

/// Whether freezedetect's output means the picture barely moved. A freeze
/// still going when the read stops never logs an end, so it runs to the end.
pub fn parse_freezedetect(stderr: &str, window: f64) -> bool {
    let decoded = decoded_seconds(stderr);
    let mut frozen = 0.0;
    let mut started: Option<f64> = None;
    for c in FREEZE.captures_iter(stderr) {
        let at: f64 = c[2].parse().unwrap_or(0.0);
        match &c[1] {
            "start" => started = Some(at),
            _ => frozen += at - started.take().unwrap_or(at),
        }
    }
    if let Some(start) = started {
        frozen += (decoded - start).max(0.0);
    }
    mostly(frozen, decoded, window)
}

// The line worth showing when ffmpeg fails, skipping filter output and the
// progress line.
fn ffmpeg_error(stderr: &str) -> Option<String> {
    stderr
        .lines()
        .map(str::trim)
        .rfind(|l| !l.is_empty() && !l.starts_with("frame=") && !l.contains("detect @") && !l.contains("Parsed_"))
        .map(str::to_string)
}

fn ffmpeg_args(url: &str, window: i64, hls: bool, check_picture: bool) -> Vec<String> {
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-nostats".into()];
    args.extend(hls_relax_args(hls).iter().map(|s| s.to_string()));
    args.extend(["-t".into(), window.to_string(), "-i".into(), url.into()]);
    if check_picture {
        args.extend(
            ["-map", "0:v:0", "-vf", "blackdetect=d=0.1,freezedetect=n=-60dB:d=2", "-f", "null", "-"].map(String::from),
        );
    }
    args.extend(["-map", "0", "-c", "copy", "-f", "mpegts", "pipe:1"].map(String::from));
    args
}

const FFPROBE_ARGS: &[&str] = &[
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_streams",
    "-show_packets",
    "-show_entries",
    "stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate:packet=stream_index,pts_time,size",
    "pipe:0",
];

/// Probe a stream URL. Set `hls` for m3u8 streams, and `check_picture` to also
/// decode it and look for a black or frozen picture.
pub async fn probe(url: &str, timeout_seconds: i64, hls: bool, check_picture: bool) -> ProbeResult {
    let window = timeout_seconds.max(1);
    let spawned = Command::new(&config().ffmpeg_path)
        .args(ffmpeg_args(url, window, hls, check_picture))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
    let mut ffmpeg = match spawned {
        Ok(c) => c,
        Err(e) => return ProbeResult::failed("error", e.to_string()),
    };
    let copy: Stdio = match ffmpeg.stdout.take().unwrap().try_into() {
        Ok(s) => s,
        Err(e) => return ProbeResult::failed("error", e.to_string()),
    };
    let mut ffprobe = match Command::new(&config().ffprobe_path)
        .args(FFPROBE_ARGS)
        .stdin(copy)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return ProbeResult::failed("error", e.to_string()),
    };

    let mut ffmpeg_err = ffmpeg.stderr.take().unwrap();
    let mut probe_out = ffprobe.stdout.take().unwrap();
    let work = async {
        let mut err = Vec::new();
        let mut out = Vec::new();
        let (_, _, status, _) = tokio::join!(
            ffmpeg_err.read_to_end(&mut err),
            probe_out.read_to_end(&mut out),
            ffmpeg.wait(),
            ffprobe.wait(),
        );
        (String::from_utf8_lossy(&err).into_owned(), out, status)
    };
    // Room to connect, then the read itself.
    let limit = Duration::from_secs((timeout_seconds.max(1) + window) as u64);
    let Ok((stderr, stdout, status)) = tokio::time::timeout(limit, work).await else {
        return ProbeResult::failed("timeout", "Probe timed out");
    };

    if !status.map(|s| s.success()).unwrap_or(false) {
        if stderr.contains("matches no streams") {
            return ProbeResult::failed("error", "No video stream found");
        }
        let msg = ffmpeg_error(&stderr).unwrap_or_else(|| "ffmpeg failed".into());
        return ProbeResult::failed("error", clean_probe_error(&msg));
    }
    let Ok(json) = serde_json::from_slice::<Value>(&stdout) else {
        return ProbeResult::failed("error", "Could not read the stream");
    };
    let quality = parse_ffprobe(&json);
    // A stream with no video track isn't a usable channel.
    if quality.width.is_none() && quality.height.is_none() {
        return ProbeResult { status: "error", quality, error: Some("No video stream found".into()), off_air: false };
    }
    if check_picture && parse_blackdetect(&stderr, window as f64) {
        return ProbeResult { status: "error", quality, error: Some("Black screen".into()), off_air: false };
    }
    let off_air = check_picture && parse_freezedetect(&stderr, window as f64);
    ProbeResult { status: "ok", quality, error: None, off_air }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_resolution_fps_codecs_and_video_bitrate() {
        let q = parse_ffprobe(&json!({
            "streams": [
                { "index": 0, "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "avg_frame_rate": "50/1" },
                { "index": 1, "codec_type": "audio", "codec_name": "aac" },
            ],
            // 100 kB of video over 0.98s plus one frame, and audio that isn't counted.
            "packets": [
                { "stream_index": 0, "pts_time": "10.000000", "size": "50000" },
                { "stream_index": 1, "pts_time": "10.000000", "size": "90000" },
                { "stream_index": 0, "pts_time": "10.980000", "size": "50000" },
            ],
        }));
        assert_eq!(q, Quality {
            width: Some(1920),
            height: Some(1080),
            fps: Some(50.0),
            video_codec: Some("h264".into()),
            audio_codec: Some("aac".into()),
            bitrate: Some(800),
        });
    }

    #[test]
    fn fractional_and_fallback_frame_rates() {
        let q = parse_ffprobe(&json!({ "streams": [{ "codec_type": "video", "width": 1280, "height": 720, "avg_frame_rate": "30000/1001" }] }));
        assert_eq!(q.fps, Some(29.97));
        let q = parse_ffprobe(&json!({ "streams": [{ "codec_type": "video", "width": 720, "height": 576, "avg_frame_rate": "0/0", "r_frame_rate": "25/1" }] }));
        assert_eq!(q.fps, Some(25.0));
    }

    #[test]
    fn audio_only_or_garbage() {
        assert_eq!(parse_ffprobe(&json!({ "streams": [{ "codec_type": "audio", "codec_name": "mp3" }] })), Quality {
            audio_codec: Some("mp3".into()),
            ..Default::default()
        });
        assert_eq!(parse_ffprobe(&Value::Null).width, None);
        assert_eq!(parse_ffprobe(&json!({})).video_codec, None);
    }

    #[test]
    fn no_packets_means_no_bitrate() {
        let q = parse_ffprobe(&json!({ "streams": [{ "index": 0, "codec_type": "video", "width": 1280, "height": 720 }], "packets": [] }));
        assert_eq!(q.bitrate, None);
    }

    const FRAME_LINE: &str = "frame=  250 fps= 25 q=-0.0 size=N/A time=00:00:10.00 bitrate=N/A speed=1x";

    #[test]
    fn blackdetect() {
        let all_black = format!("[blackdetect @ 0x1] black_start:0 black_end:9.8 black_duration:9.8\n{FRAME_LINE}");
        assert!(parse_blackdetect(&all_black, 10.0));
        let blip = format!("[blackdetect @ 0x1] black_start:2 black_end:2.6 black_duration:0.6\n{FRAME_LINE}");
        assert!(!parse_blackdetect(&blip, 10.0));
        assert!(!parse_blackdetect(FRAME_LINE, 10.0));
        assert!(!parse_blackdetect("[blackdetect @ 0x1] black_start:0 black_end:0.4 black_duration:0.4", 10.0));
        let runs = format!(
            "[blackdetect @ 0x1] black_start:0 black_end:5 black_duration:5\n\
             [blackdetect @ 0x1] black_start:5.2 black_end:10 black_duration:4.5\n{FRAME_LINE}"
        );
        assert!(parse_blackdetect(&runs, 10.0));
    }

    #[test]
    fn freezedetect() {
        // Frozen from the first frame and still frozen when the read stopped.
        let slate = format!("[Parsed_freezedetect_1 @ 0x1] lavfi.freezedetect.freeze_start: 0.0232222\n{FRAME_LINE}");
        assert!(parse_freezedetect(&slate, 10.0));
        let pause = format!(
            "[Parsed_freezedetect_1 @ 0x1] lavfi.freezedetect.freeze_start: 3\n\
             [Parsed_freezedetect_1 @ 0x1] lavfi.freezedetect.freeze_duration: 2.5\n\
             [Parsed_freezedetect_1 @ 0x1] lavfi.freezedetect.freeze_end: 5.5\n{FRAME_LINE}"
        );
        assert!(!parse_freezedetect(&pause, 10.0));
        assert!(!parse_freezedetect(FRAME_LINE, 10.0));
    }

    // Needs ffmpeg and ffprobe installed, so it only runs with --ignored.
    #[tokio::test]
    #[ignore]
    async fn probes_real_clips() {
        let dir = tempfile::tempdir().unwrap();
        let make = |name: &str, video: &str| {
            let path = dir.path().join(name);
            let ok = std::process::Command::new(&config().ffmpeg_path)
                .args(["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", video])
                .args(["-f", "lavfi", "-i", "sine=d=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"])
                .arg(&path)
                .status()
                .unwrap()
                .success();
            assert!(ok, "couldn't make {name}");
            path.to_string_lossy().into_owned()
        };
        let moving = make("moving.ts", "testsrc2=s=1280x720:r=50:d=8");
        let frozen = make("frozen.ts", "testsrc2=s=1280x720:r=25:d=1,loop=loop=-1:size=1,trim=duration=8");
        let black = make("black.ts", "color=c=black:s=1280x720:r=25:d=8");

        let r = probe(&moving, 5, false, true).await;
        assert_eq!((r.status, r.off_air), ("ok", false), "{r:?}");
        assert_eq!((r.quality.height, r.quality.fps, r.quality.video_codec.as_deref()), (Some(720), Some(50.0), Some("h264")));
        assert_eq!(r.quality.audio_codec.as_deref(), Some("aac"));
        assert!(r.quality.bitrate.unwrap_or(0) > 500, "{r:?}");

        let r = probe(&frozen, 5, false, true).await;
        assert_eq!((r.status, r.off_air), ("ok", true), "{r:?}");

        let r = probe(&black, 5, false, true).await;
        assert_eq!((r.status, r.error.as_deref()), ("error", Some("Black screen")), "{r:?}");

        // Without the picture check nothing is decoded, so a frozen picture passes as normal.
        let r = probe(&frozen, 5, false, false).await;
        assert_eq!((r.status, r.off_air), ("ok", false), "{r:?}");

        let r = probe(&dir.path().join("missing.ts").to_string_lossy(), 5, false, true).await;
        assert_eq!(r.status, "error", "{r:?}");
    }

    #[test]
    fn ffmpeg_error_skips_filter_and_progress_lines() {
        let stderr = "[in#0 @ 0x1] Error opening input: Server returned 404 Not Found\n\
                      Error opening input files: Server returned 404 Not Found\n";
        assert_eq!(ffmpeg_error(stderr).as_deref(), Some("Error opening input files: Server returned 404 Not Found"));
        let noisy = format!("Real problem\n[Parsed_freezedetect_1 @ 0x1] lavfi.freezedetect.freeze_start: 0\n{FRAME_LINE}");
        assert_eq!(ffmpeg_error(&noisy).as_deref(), Some("Real problem"));
    }
}
