import { describe, expect, it } from "vitest";
import { buildM3u } from "~/services/output/m3u.server";
import type { ResolvedChannel } from "~/services/output/queries.server";

function channel(over: Partial<ResolvedChannel> = {}): ResolvedChannel {
  return {
    displayName: "BBC One",
    logo: "http://logos/bbc1.png",
    groupTitle: "UK",
    tvgId: "bbc1.uk",
    epgSourceId: 1,
    streamUrl: "http://example.com/live/u/p/1.ts",
    ...over,
  };
}

describe("buildM3u", () => {
  it("starts with the header carrying the epg url", () => {
    const out = buildM3u([], "http://host/output/epg/tok");
    expect(out).toBe(`#EXTM3U url-tvg="http://host/output/epg/tok"\n`);
  });

  it("writes an EXTINF line and the stream url for each channel", () => {
    const out = buildM3u([channel()], "http://host/epg");
    expect(out).toBe(
      `#EXTM3U url-tvg="http://host/epg"\n` +
        `#EXTINF:-1 tvg-id="bbc1.uk" tvg-name="BBC One" tvg-logo="http://logos/bbc1.png" group-title="UK",BBC One\n` +
        `http://example.com/live/u/p/1.ts\n`,
    );
  });

  it("keeps channels in the given order", () => {
    const out = buildM3u(
      [channel({ displayName: "One" }), channel({ displayName: "Two" })],
      "http://host/epg",
    );
    expect(out.indexOf("One")).toBeLessThan(out.indexOf("Two"));
  });

  it("strips double quotes so they can't break out of an attribute", () => {
    const out = buildM3u(
      [channel({ displayName: `Sky "Sports"`, groupTitle: `A "B"` })],
      "http://host/epg",
    );
    expect(out).not.toContain(`"Sports"`);
    expect(out).toContain(`tvg-name="Sky  Sports"`);
    expect(out).toContain(`group-title="A  B"`);
  });

  it("ends with a trailing newline", () => {
    expect(buildM3u([channel()], "http://host/epg").endsWith("\n")).toBe(true);
  });
});
