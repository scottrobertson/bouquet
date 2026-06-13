import { describe, expect, it } from "vitest";
import {
  buildStreamUrl,
  normalizeServerUrl,
  parseEpgChannels,
  xmltvUrl,
} from "~/services/xtream/client.server";

const creds = {
  serverUrl: "http://example.com:8080",
  username: "user",
  password: "pass",
};

describe("normalizeServerUrl", () => {
  it("strips trailing slashes and whitespace", () => {
    expect(normalizeServerUrl("  http://example.com/// ")).toBe("http://example.com");
  });

  it("leaves a clean url alone", () => {
    expect(normalizeServerUrl("http://example.com:8080")).toBe("http://example.com:8080");
  });
});

describe("buildStreamUrl", () => {
  it("builds the direct stream url with .ts by default", () => {
    expect(buildStreamUrl(creds, "123")).toBe(
      "http://example.com:8080/live/user/pass/123.ts",
    );
  });

  it("honours the extension", () => {
    expect(buildStreamUrl(creds, "123", "m3u8")).toBe(
      "http://example.com:8080/live/user/pass/123.m3u8",
    );
  });

  it("url-encodes credentials with special characters", () => {
    const url = buildStreamUrl(
      { serverUrl: "http://x.com", username: "a b", password: "p@ss/word" },
      "9",
    );
    expect(url).toBe("http://x.com/live/a%20b/p%40ss%2Fword/9.ts");
  });
});

describe("xmltvUrl", () => {
  it("builds the xmltv.php url with credentials", () => {
    expect(xmltvUrl(creds)).toBe(
      "http://example.com:8080/xmltv.php?username=user&password=pass",
    );
  });
});

describe("parseEpgChannels", () => {
  it("pulls id, display name, and icon from channel blocks", () => {
    const xml = `<?xml version="1.0"?><tv>
      <channel id="bbc1.uk">
        <display-name>BBC One</display-name>
        <icon src="http://logos/bbc1.png" />
      </channel>
      <channel id="itv.uk">
        <display-name>ITV</display-name>
      </channel>
    </tv>`;
    expect(parseEpgChannels(xml)).toEqual([
      { channelId: "bbc1.uk", displayName: "BBC One", icon: "http://logos/bbc1.png" },
      { channelId: "itv.uk", displayName: "ITV", icon: null },
    ]);
  });

  it("decodes xml entities in ids and names", () => {
    const xml = `<channel id="a&amp;b"><display-name>Tom &amp; Jerry</display-name></channel>`;
    expect(parseEpgChannels(xml)).toEqual([
      { channelId: "a&b", displayName: "Tom & Jerry", icon: null },
    ]);
  });

  it("keeps the first definition when a channel id repeats", () => {
    const xml = `
      <channel id="dup"><display-name>First</display-name></channel>
      <channel id="dup"><display-name>Second</display-name></channel>`;
    const result = parseEpgChannels(xml);
    expect(result).toHaveLength(1);
    expect(result[0].displayName).toBe("First");
  });

  it("skips channels with an empty id", () => {
    const xml = `<channel id=""><display-name>Nameless</display-name></channel>`;
    expect(parseEpgChannels(xml)).toEqual([]);
  });

  it("returns nothing for xml with no channels", () => {
    expect(parseEpgChannels("<tv></tv>")).toEqual([]);
  });
});
