use super::resolve::ResolvedChannel;
use crate::js;

// Strip double quotes so they can't break out of an EXTINF attribute.
fn attr(value: &str) -> String {
    js::trim(&value.replace('"', " ")).to_string()
}

pub fn build_m3u(rows: &[ResolvedChannel], epg_url: &str) -> String {
    let mut out = format!("#EXTM3U url-tvg=\"{}\"\n", attr(epg_url));
    for c in rows {
        let name = attr(&c.display_name);
        // xc tells the player to build the timeshift URL from the stream URL
        // itself. A catchup-source template can't work everywhere: TiviMate
        // leaves some placeholders unfilled and fills times in UTC when panels
        // expect their own timezone, so every request failed.
        let catchup = if c.catchup_days > 0 {
            format!(" catchup=\"xc\" catchup-days=\"{}\"", c.catchup_days)
        } else {
            String::new()
        };
        out.push_str(&format!(
            "#EXTINF:-1 tvg-id=\"{}\" tvg-name=\"{name}\" tvg-logo=\"{}\" group-title=\"{}\"{catchup},{name}\n",
            attr(&c.tvg_id),
            attr(&c.logo),
            attr(&c.group_title),
        ));
        out.push_str(&c.stream_url);
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn channel() -> ResolvedChannel {
        ResolvedChannel {
            display_name: "BBC One".into(),
            logo: "http://logos/bbc1.png".into(),
            group_title: "UK".into(),
            tvg_id: "bbc1.uk".into(),
            epg_source_id: 1,
            stream_url: "http://example.com/live/u/p/1.ts".into(),
            catchup_days: 0,
            catchup_source: String::new(),
        }
    }

    #[test]
    fn header_carries_the_epg_url() {
        assert_eq!(build_m3u(&[], "http://host/output/epg/tok"), "#EXTM3U url-tvg=\"http://host/output/epg/tok\"\n");
    }

    #[test]
    fn writes_extinf_and_stream_url() {
        assert_eq!(
            build_m3u(&[channel()], "http://host/epg"),
            "#EXTM3U url-tvg=\"http://host/epg\"\n\
             #EXTINF:-1 tvg-id=\"bbc1.uk\" tvg-name=\"BBC One\" tvg-logo=\"http://logos/bbc1.png\" group-title=\"UK\",BBC One\n\
             http://example.com/live/u/p/1.ts\n"
        );
    }

    #[test]
    fn keeps_channel_order() {
        let out = build_m3u(
            &[ResolvedChannel { display_name: "One".into(), ..channel() }, ResolvedChannel { display_name: "Two".into(), ..channel() }],
            "http://host/epg",
        );
        assert!(out.find("One").unwrap() < out.find("Two").unwrap());
    }

    #[test]
    fn strips_double_quotes() {
        let out = build_m3u(
            &[ResolvedChannel { display_name: "Sky \"Sports\"".into(), group_title: "A \"B\"".into(), ..channel() }],
            "http://host/epg",
        );
        assert!(!out.contains("\"Sports\""));
        assert!(out.contains("tvg-name=\"Sky  Sports\""));
        assert!(out.contains("group-title=\"A  B\""));
    }

    #[test]
    fn catchup_attributes_only_with_an_archive() {
        let with = build_m3u(
            &[ResolvedChannel { catchup_days: 7, catchup_source: "http://x/timeshift/{duration:60}".into(), ..channel() }],
            "http://host/epg",
        );
        assert!(with.contains("catchup=\"xc\" catchup-days=\"7\""));
        assert!(!with.contains("catchup-source"));
        assert!(!build_m3u(&[channel()], "http://host/epg").contains("catchup"));
    }
}
