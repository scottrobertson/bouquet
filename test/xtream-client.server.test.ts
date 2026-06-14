import { describe, expect, it } from "vitest";
import {
  buildStreamUrl,
  normalizeServerUrl,
  parseSimpleDataTable,
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

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

describe("parseSimpleDataTable", () => {
  it("decodes base64 fields and uses the unix timestamps", () => {
    const data = {
      epg_listings: [
        {
          title: b64("The News"),
          description: b64("Headlines & weather."),
          start_timestamp: "1705327200",
          stop_timestamp: "1705330800",
          has_archive: 1,
        },
      ],
    };
    expect(parseSimpleDataTable(data, "bbc1.uk")).toEqual([
      {
        channelId: "bbc1.uk",
        startTs: 1705327200,
        stopTs: 1705330800,
        title: "The News",
        description: "Headlines & weather.",
        hasArchive: true,
      },
    ]);
  });

  it("flags programmes without an archive", () => {
    const data = {
      epg_listings: [
        {
          title: b64("Soap"),
          description: "",
          start_timestamp: "100",
          stop_timestamp: "200",
          has_archive: 0,
        },
      ],
    };
    const progs = parseSimpleDataTable(data, "itv.uk");
    expect(progs[0].hasArchive).toBe(false);
    expect(progs[0].description).toBeNull();
  });

  it("drops listings with missing or backwards times", () => {
    const data = {
      epg_listings: [
        { title: b64("No times") },
        { title: b64("Backwards"), start_timestamp: "200", stop_timestamp: "100" },
      ],
    };
    expect(parseSimpleDataTable(data, "x")).toEqual([]);
  });

  it("returns nothing when there are no listings", () => {
    expect(parseSimpleDataTable({}, "x")).toEqual([]);
    expect(parseSimpleDataTable(null, "x")).toEqual([]);
  });
});
