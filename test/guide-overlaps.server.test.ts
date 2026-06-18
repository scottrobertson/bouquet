import { describe, expect, it } from "vitest";
import {
  type GuideProgramme,
  resolveOverlaps,
} from "~/services/guide/guide.server";

function prog(startTs: number, stopTs: number, title = "x"): GuideProgramme {
  return {
    startTs,
    stopTs,
    title,
    subTitle: null,
    description: null,
    category: null,
  };
}

describe("resolveOverlaps", () => {
  it("leaves back-to-back programmes untouched", () => {
    const out = resolveOverlaps([prog(0, 100), prog(100, 200)]);
    expect(out).toEqual([prog(0, 100), prog(100, 200)]);
  });

  it("trims a programme that runs into the next one", () => {
    const out = resolveOverlaps([prog(0, 150), prog(100, 200)]);
    expect(out).toEqual([prog(0, 100), prog(100, 200)]);
  });

  it("drops exact duplicates", () => {
    const out = resolveOverlaps([prog(0, 100, "a"), prog(0, 100, "b")]);
    expect(out).toHaveLength(1);
    expect(out[0].startTs).toBe(0);
    expect(out[0].stopTs).toBe(100);
  });

  it("keeps the longer programme when starts are equal", () => {
    const out = resolveOverlaps([prog(0, 100, "short"), prog(0, 200, "long")]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("long");
  });

  it("drops a programme fully covered by a longer one", () => {
    const out = resolveOverlaps([prog(0, 300, "long"), prog(50, 100, "inner")]);
    expect(out).toEqual([prog(0, 300, "long")]);
  });

  it("sorts unordered input before resolving", () => {
    const out = resolveOverlaps([prog(200, 300), prog(0, 100)]);
    expect(out).toEqual([prog(0, 100), prog(200, 300)]);
  });
});
