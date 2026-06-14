import { describe, expect, it } from "vitest";
import { formatXmltvTime, programmeBlock } from "~/services/output/xmltv.server";

describe("formatXmltvTime", () => {
  it("formats unix seconds as a UTC xmltv timestamp", () => {
    expect(formatXmltvTime(Date.UTC(2024, 0, 15, 14, 0, 0) / 1000)).toBe(
      "20240115140000 +0000",
    );
  });
});

describe("programmeBlock", () => {
  it("builds a programme element from stored fields", () => {
    const block = programmeBlock({
      channelId: "bbc1.uk",
      startTs: Date.UTC(2024, 0, 15, 14, 0, 0) / 1000,
      stopTs: Date.UTC(2024, 0, 15, 15, 0, 0) / 1000,
      title: "The News",
      subTitle: null,
      description: "Headlines & weather.",
      category: null,
    });
    expect(block).toContain('channel="bbc1.uk"');
    expect(block).toContain('start="20240115140000 +0000"');
    expect(block).toContain('stop="20240115150000 +0000"');
    expect(block).toContain("<title>The News</title>");
    expect(block).toContain("<desc>Headlines &amp; weather.</desc>");
  });

  it("omits fields that aren't set", () => {
    const block = programmeBlock({
      channelId: "itv.uk",
      startTs: 100,
      stopTs: 200,
      title: "Soap",
      subTitle: null,
      description: null,
      category: null,
    });
    expect(block).not.toContain("sub-title");
    expect(block).not.toContain("<desc>");
    expect(block).not.toContain("<category>");
  });
});
