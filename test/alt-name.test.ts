import { describe, expect, it } from "vitest";
import { altName } from "~/services/playlist/alt-name";

const strong = { name: "BBC One", n: 1, provider: "Strong8k" };

describe("altName", () => {
  it("fills in the name and number", () => {
    expect(
      altName("{name} (Backup {n})", { ...strong, name: "BBC One FHD" }),
    ).toBe("BBC One FHD (Backup 1)");
    expect(altName("{name} (Alt {n})", { ...strong, n: 2 })).toBe(
      "BBC One (Alt 2)",
    );
  });

  it("replaces every occurrence of a token", () => {
    expect(altName("{name} {name} #{n}", { ...strong, name: "Sky", n: 3 })).toBe(
      "Sky Sky #3",
    );
  });

  it("works with a custom template shape", () => {
    expect(altName("[{n}] {name}", { ...strong, name: "ITV", n: 4 })).toBe(
      "[4] ITV",
    );
  });

  it("fills in the provider name and its first letter", () => {
    expect(altName("{name} ({provider})", strong)).toBe("BBC One (Strong8k)");
    expect(altName("{name} {provider_letter}{n}", strong)).toBe("BBC One S1");
    expect(altName("{provider} {provider_letter}", strong)).toBe("Strong8k S");
  });

  it("upper-cases the provider letter and ignores leading spaces", () => {
    expect(
      altName("{provider_letter}", { ...strong, provider: "  nova tv" }),
    ).toBe("N");
    expect(altName("{provider_letter}", { ...strong, provider: "" })).toBe("");
  });
});
