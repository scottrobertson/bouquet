import { describe, expect, it } from "vitest";
import { altName } from "~/services/playlist/alt-name";

describe("altName", () => {
  it("fills in the name and number", () => {
    expect(altName("{name} (Backup {n})", "BBC One FHD", 1)).toBe(
      "BBC One FHD (Backup 1)",
    );
    expect(altName("{name} (Alt {n})", "BBC One", 2)).toBe("BBC One (Alt 2)");
  });

  it("replaces every occurrence of a token", () => {
    expect(altName("{name} {name} #{n}", "Sky", 3)).toBe("Sky Sky #3");
  });

  it("works with a custom template shape", () => {
    expect(altName("[{n}] {name}", "ITV", 4)).toBe("[4] ITV");
  });
});
