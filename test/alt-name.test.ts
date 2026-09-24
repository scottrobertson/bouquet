import { describe, expect, it } from "vitest";
import { altName, channelName } from "~/services/playlist/alt-name";

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

  it("leaves placeholders inside the channel or provider name alone", () => {
    expect(
      altName("{name} ({provider})", { name: "Test {n}", n: 2, provider: "{name}" }),
    ).toBe("Test {n} ({name})");
  });
});

describe("channelName", () => {
  const b1g = { name: "Sky Sports 1 UHD", provider: "b1g" };

  it("leaves the name as it is with the default template", () => {
    expect(channelName("{name}", b1g)).toBe("Sky Sports 1 UHD");
  });

  it("fills in the provider name and its first letter", () => {
    expect(channelName("{name} ({provider_letter})", b1g)).toBe(
      "Sky Sports 1 UHD (B)",
    );
    expect(channelName("[{provider}] {name}", b1g)).toBe("[b1g] Sky Sports 1 UHD");
  });

  it("keeps {n} as written, since only alternates have a number", () => {
    expect(channelName("{name} {n}", b1g)).toBe("Sky Sports 1 UHD {n}");
  });
});
