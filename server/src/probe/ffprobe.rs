//! Runs ffprobe and ffmpeg against a stream URL to read its quality.

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
    // Overall stream bitrate in kbps, when the provider reports it.
    pub bitrate: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProbeResult {
    pub status: &'static str,
    pub quality: Quality,
    pub error: Option<String>,
}

impl ProbeResult {
    fn failed(status: &'static str, error: impl Into<String>) -> ProbeResult {
        ProbeResult { status, quality: Quality::default(), error: Some(error.into()) }
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

/// The fields we store from ffprobe's JSON.
pub fn parse_ffprobe(json: &Value) -> Quality {
    let Some(streams) = json.get("streams").and_then(|s| s.as_array()) else { return Quality::default() };
    let of_type = |t: &str| streams.iter().find(|s| s.get("codec_type").and_then(|c| c.as_str()) == Some(t));
    let video = of_type("video");
    let audio = of_type("audio");
    let codec = |s: Option<&Value>| s.and_then(|s| s.get("codec_name")).and_then(|c| c.as_str()).map(String::from);
    Quality {
        width: positive_int(video.and_then(|v| v.get("width"))),
        height: positive_int(video.and_then(|v| v.get("height"))),
        fps: parse_frame_rate(video.and_then(|v| v.get("avg_frame_rate")))
            .or_else(|| parse_frame_rate(video.and_then(|v| v.get("r_frame_rate")))),
        video_codec: codec(video),
        audio_codec: codec(audio),
        bitrate: positive_int(json.get("format").and_then(|f| f.get("bit_rate")))
            .map(|bps| (bps as f64 / 1000.0).round() as i64),
    }
}

struct RunOutput {
    timed_out: bool,
    // None when the program couldn't be started at all.
    status: Option<std::process::ExitStatus>,
    stdout_bytes: Vec<u8>,
    stdout_len: usize,
    stderr: String,
    spawn_error: Option<String>,
}

/// Run a program and gather its output, killing it once `limit` passes so a
/// stuck stream never ties up a worker. With `count_stdout`, stdout is only
/// measured, not kept, since it can be megabytes of video.
async fn run(program: &str, args: &[String], limit: Duration, count_stdout: bool) -> RunOutput {
    let mut child = match Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return RunOutput {
                timed_out: false,
                status: None,
                stdout_bytes: vec![],
                stdout_len: 0,
                stderr: String::new(),
                spawn_error: Some(e.to_string()),
            };
        }
    };
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let read_out = async move {
        let mut kept = Vec::new();
        let mut len = 0;
        let mut buf = vec![0u8; 64 * 1024];
        while let Ok(n) = stdout.read(&mut buf).await {
            if n == 0 {
                break;
            }
            len += n;
            if !count_stdout {
                kept.extend_from_slice(&buf[..n]);
            }
        }
        (kept, len)
    };
    let read_err = async move {
        let mut s = Vec::new();
        let _ = stderr.read_to_end(&mut s).await;
        String::from_utf8_lossy(&s).into_owned()
    };
    let work = async { tokio::join!(read_out, read_err, child.wait()) };
    match tokio::time::timeout(limit, work).await {
        Ok(((kept, len), err, status)) => RunOutput {
            timed_out: false,
            status: status.ok(),
            stdout_bytes: kept,
            stdout_len: len,
            stderr: err,
            spawn_error: None,
        },
        Err(_) => {
            // The output readers were dropped with the timed out future, so all
            // that's left is to stop the process.
            let _ = child.kill().await;
            RunOutput { timed_out: true, status: None, stdout_bytes: vec![], stdout_len: 0, stderr: String::new(), spawn_error: None }
        }
    }
}

/// ffprobe a stream URL. Set `hls` for m3u8 streams.
pub async fn probe_stream(url: &str, timeout_seconds: i64, hls: bool) -> ProbeResult {
    let mut args: Vec<String> = vec!["-v".into(), "error".into()];
    args.extend(hls_relax_args(hls).iter().map(|s| s.to_string()));
    args.extend(["-print_format", "json", "-show_streams", "-show_format", url].map(String::from));
    let out = run(&config().ffprobe_path, &args, Duration::from_secs(timeout_seconds.max(1) as u64), false).await;

    if let Some(e) = out.spawn_error {
        return ProbeResult::failed("error", e);
    }
    if out.timed_out {
        return ProbeResult::failed("timeout", "Probe timed out");
    }
    let status = out.status.expect("a finished process has a status");
    if !status.success() {
        let last = out.stderr.trim().lines().last().map(str::to_string).filter(|l| !l.is_empty());
        let msg = last.unwrap_or_else(|| match status.code() {
            Some(code) => format!("ffprobe exited {code}"),
            None => "ffprobe exited null".into(),
        });
        return ProbeResult::failed("error", clean_probe_error(&msg));
    }
    let Ok(json) = serde_json::from_slice::<Value>(&out.stdout_bytes) else {
        return ProbeResult::failed("error", "Could not parse ffprobe output");
    };
    let quality = parse_ffprobe(&json);
    // A stream with no video track isn't a usable channel.
    if quality.width.is_none() && quality.height.is_none() {
        return ProbeResult { status: "error", quality, error: Some("No video stream found".into()) };
    }
    ProbeResult { status: "ok", quality, error: None }
}

// Near-black frames have to cover this much of what was decoded. High, so
// fades and ad breaks don't trip it.
const BLACK_FRACTION: f64 = 0.9;

static BLACK_DURATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"black_duration:([\d.]+)").unwrap());
static DECODE_TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"time=(\d+:\d+:\d+\.\d+)").unwrap());
static OUT_TIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"out_time=(\d+:\d+:\d+\.\d+)").unwrap());

// HH:MM:SS.ss in seconds.
fn parse_timestamp(value: &str) -> f64 {
    let parts: Vec<f64> = value.split(':').map(|p| p.parse().unwrap_or(f64::NAN)).collect();
    match parts.as_slice() {
        [h, m, s] if parts.iter().all(|p| p.is_finite()) => h * 3600.0 + m * 60.0 + s,
        _ => 0.0,
    }
}

/// Whether blackdetect's output means the picture was all black. Too little
/// decoded counts as inconclusive, so a stream that stalls early isn't failed.
pub fn parse_blackdetect(stderr: &str, window: f64) -> bool {
    let black: f64 = BLACK_DURATION.captures_iter(stderr).map(|c| c[1].parse::<f64>().unwrap_or(0.0)).sum();
    let decoded = DECODE_TIME.captures_iter(stderr).map(|c| parse_timestamp(&c[1])).fold(0.0, f64::max);
    if decoded < window.min(1.0) {
        return false;
    }
    black / decoded >= BLACK_FRACTION
}

/// Read a stream for `seconds` with ffmpeg's blackdetect filter. Any error
/// counts as not black, so an inconclusive run never fails a channel.
pub async fn detect_black_screen(url: &str, seconds: i64, hls: bool) -> bool {
    let window = seconds.max(1);
    let mut args: Vec<String> = vec!["-hide_banner".into()];
    args.extend(hls_relax_args(hls).iter().map(|s| s.to_string()));
    args.extend(["-t".into(), window.to_string(), "-i".into(), url.into()]);
    args.extend(["-an", "-vf", "blackdetect=d=0.1", "-f", "null", "-"].map(String::from));
    // A little past the window, so a healthy stream finishes on its own first.
    let out = run(&config().ffmpeg_path, &args, Duration::from_secs(window as u64 + 5), true).await;
    if out.spawn_error.is_some() || out.timed_out {
        return false;
    }
    parse_blackdetect(&out.stderr, window as f64)
}

/// kbps from bytes read over a window.
pub fn bitrate_kbps(bytes: usize, seconds: f64) -> Option<i64> {
    if bytes == 0 || seconds <= 0.0 {
        return None;
    }
    Some((bytes as f64 * 8.0 / seconds / 1000.0).round() as i64)
}

/// The real muxed duration from ffmpeg's -progress output. Zero if none.
pub fn parse_progress_seconds(stderr: &str) -> f64 {
    OUT_TIME.captures_iter(stderr).map(|c| parse_timestamp(&c[1])).fold(0.0, f64::max)
}

/// Measure a stream's real bitrate by reading it for `seconds` and weighing
/// the bytes. ffprobe can't report this for live streams. Divides by what
/// ffmpeg actually muxed, so a stream that delivers less than asked still
/// reads right.
pub async fn measure_bitrate(url: &str, seconds: i64, hls: bool) -> Option<i64> {
    let window = seconds.max(1);
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into()];
    args.extend(hls_relax_args(hls).iter().map(|s| s.to_string()));
    args.extend(["-t".into(), window.to_string(), "-i".into(), url.into()]);
    args.extend(["-c", "copy", "-f", "mpegts", "pipe:1", "-progress", "pipe:2"].map(String::from));
    let out = run(&config().ffmpeg_path, &args, Duration::from_secs(window as u64 + 5), true).await;
    if out.spawn_error.is_some() || out.timed_out {
        return None;
    }
    let elapsed = match parse_progress_seconds(&out.stderr) {
        s if s > 0.0 => s,
        _ => window as f64,
    };
    bitrate_kbps(out.stdout_len, elapsed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_resolution_fps_and_codecs() {
        let q = parse_ffprobe(&json!({
            "streams": [
                { "codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "avg_frame_rate": "50/1" },
                { "codec_type": "audio", "codec_name": "aac" },
            ],
            "format": { "bit_rate": "8200000" },
        }));
        assert_eq!(q, Quality {
            width: Some(1920),
            height: Some(1080),
            fps: Some(50.0),
            video_codec: Some("h264".into()),
            audio_codec: Some("aac".into()),
            bitrate: Some(8200),
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
    fn bitrate_and_progress() {
        assert_eq!(bitrate_kbps(5_538_104, 6.0), Some(7384));
        assert_eq!(bitrate_kbps(0, 6.0), None);
        assert_eq!(bitrate_kbps(1000, 0.0), None);
        let progress = "out_time=00:00:05.000000\nprogress=continue\nout_time=00:00:10.000000\nprogress=continue\nout_time=00:00:09.500000\nprogress=end";
        assert_eq!(parse_progress_seconds(progress), 10.0);
        assert!((parse_progress_seconds("out_time=00:00:06.200000\nprogress=end") - 6.2).abs() < 1e-9);
        assert_eq!(parse_progress_seconds(""), 0.0);
        assert_eq!(parse_progress_seconds("out_time=N/A\nprogress=continue"), 0.0);
    }
}
