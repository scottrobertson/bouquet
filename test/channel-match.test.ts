import { describe, expect, it } from "vitest";
import {
  channelKey,
  nameSimilarity,
  normaliseChannelName,
  suggestPrimaries,
} from "~/services/playlist/channel-match";

// Every name in this file is a real one from a 39,000 channel catalogue across
// two providers.

/** Whether the picker would offer `primary` when you add `picked` as an
    alternate. */
function suggests(picked: string, primary: string, epg?: [string, string]) {
  const out = suggestPrimaries(
    [{ name: picked, epgChannelId: epg?.[0] ?? null }],
    [{ id: 1, name: primary, epgChannelId: epg?.[1] ?? null }],
  );
  return out.length > 0;
}

describe("normaliseChannelName", () => {
  it("strips country tags and quality suffixes", () => {
    expect(normaliseChannelName("UK: Sky Sports Main Event FHD")).toBe(
      "sky sports main event",
    );
    expect(normaliseChannelName("|UK| SKY SPORTS MAIN EVENT ᴴᴰ")).toBe(
      "sky sports main event",
    );
    expect(normaliseChannelName("US - ESPN [1080p]")).toBe("espn");
    expect(normaliseChannelName("uk:BBC One HEVC")).toBe("bbc one");
    expect(normaliseChannelName("D2H| STAR SPORTS 2 FHD")).toBe("star sports 2");
    expect(normaliseChannelName("[Sky Stream] 102 BBC Two HD Network")).toBe(
      "102 bbc two network",
    );
  });

  it("strips the frame rate, the surround marker and the copy number", () => {
    expect(normaliseChannelName("UK: TNT Sports 1 FHD 50FPS 5.1")).toBe(
      "tnt sports 1",
    );
    expect(normaliseChannelName("UK: Sky Sports Main Event FHD3")).toBe(
      "sky sports main event",
    );
    expect(normaliseChannelName("UK: TNT Sport Ultimate UHD2")).toBe(
      "tnt sport ultimate",
    );
  });

  it("reads the decorated letters providers use", () => {
    expect(normaliseChannelName("BRA: CARTOON NETWORK ʙʀᴀsɪʟ ᴴᴰ")).toBe(
      "cartoon network brasil",
    );
    expect(normaliseChannelName("ARG: INVESTIGATION DISCOVERY Pʳᵉᵐⁱᵘᵐ ʜᴅ")).toBe(
      "investigation discovery premium",
    );
  });

  it("keeps a colon that belongs to the name", () => {
    expect(normaliseChannelName("Sky Sports: Main Event")).toBe(
      "sky sports main event",
    );
  });

  it("writes a channel number the same either way", () => {
    expect(normaliseChannelName("UK: ITV 2 FHD")).toBe("itv 2");
    expect(normaliseChannelName("UK: ITV2")).toBe("itv 2");
    expect(normaliseChannelName("UK: More4 FHD")).toBe("more 4");
    expect(normaliseChannelName("More 4 HD")).toBe("more 4");
  });

  it("picks out the country tag, the timeshift and the numbers", () => {
    expect(channelKey("BRA: TNT HD")).toEqual({
      name: "tnt",
      country: "bra",
      timeshift: null,
      numbers: [],
    });
    expect(channelKey("UK: Investigation Discovery+1 SD")).toEqual({
      name: "investigation discovery",
      country: "uk",
      timeshift: "1",
      numbers: [],
    });
    // "Sky Sports+" is its own channel, and the 50FPS must not read as a
    // timeshift.
    expect(channelKey("UK: Sky Sports+ 50FPS 5.1").timeshift).toBe(null);
    expect(channelKey("[Sky Stream] Sky Sports F1").country).toBe(null);
  });
});

describe("nameSimilarity", () => {
  it("scores an abbreviation as close", () => {
    expect(
      nameSimilarity("sky sp main event", "sky sports main event"),
    ).toBeGreaterThan(0.62);
  });

  it("keeps channels in the same family apart", () => {
    expect(
      nameSimilarity("sky sports main event", "sky sports football"),
    ).toBeLessThan(0.62);
    expect(nameSimilarity("bbc one", "bbc two")).toBeLessThan(0.62);
  });
});

describe("the same channel from two providers", () => {
  const same: [string, string][] = [
    ["UK: Sky Sports Main Event FHD", "Sky Sports Main Event"],
    ["|UK| SKY SPORTS MAIN EVENT ᴴᴰ", "UK: Sky Sports Main Event FHD2"],
    ["UK: Sky Sports Main Event UHD", "UK: Sky Sports Main Event HD"],
    ["UK: TNT Sports 1 FHD 50FPS 5.1", "UK: TNT Sports 1 FHD"],
    ["UK: TNT Sport Ultimate UHD2", "UK: TNT Sport Ultimate UHD"],
    ["UK: ITV 2 FHD", "UK: ITV2"],
    ["UK: More4 FHD", "More 4 SD"],
    ["UK: BBC One FHD", "BBC One HD"],
    ["Sky Sp Main Event", "Sky Sports Main Event FHD"],
    ["UK: Sky Sports F1 UHD2", "Sky Sports F1 FHD"],
    ["TS| STAR SPORTS 2 FHD", "D2H| STAR SPORTS 2 FHD"],
    ["UK: Sky Cinema Select HD", "UK: Sky Cinema Select FHD 5.1"],
    ["U&Alibi FHD", "Alibi FHD 5.1"],
    ["UK: DMAX+1 SD", "DMAX +1 SD"],
    ["US: ESPNU HD", "US: ESPN U"],
  ];

  for (const [a, b] of same) {
    it(`"${a}" is "${b}"`, () => {
      expect(suggests(a, b)).toBe(true);
    });
  }
});

describe("different channels that look alike", () => {
  const different: [string, string][] = [
    // The one that started this: same family, different sport.
    ["UK: Sky Sports Cricket FHD", "UK: Sky Sports Golf FHD"],
    ["UK: Sky Sports Cricket FHD", "UK: Sky Sports Tennis FHD"],
    ["UK: Sky Sports Main Event FHD", "UK: Sky Sports Football FHD"],
    // Numbered siblings.
    ["UK: TNT Sports 1 FHD", "UK: TNT Sport 2 FHD"],
    ["Eurosport 1", "Eurosport 2"],
    ["UK: ITV 2 FHD", "UK: ITV3"],
    ["NO: TV2 Sport Premium HD", "NO: TV2 Sport Premium 2 HD"],
    ["ES: LALIGA TV HYPERMOTION", "ES: LALIGA TV HYPERMOTION 3"],
    ["NO V Sport Premier League", "NO V Sport Premier League 2"],
    ["Flo Sports 77:", "Flo Sports 777:"],
    // An hour behind is not the same channel.
    ["UK: Investigation Discovery FHD", "UK: Investigation Discovery+1 SD"],
    ["ITV1 Granada +1 SD", "ITV1 Granada FHD"],
    ["UK: Quest Red+1 SD", "UK: Quest+1 SD"],
    // Same name, different country.
    ["US: TNT FHD", "BRA: TNT HD"],
    ["AU: Investigation Discovery", "MX: Investigation Discovery"],
    ["BRA: CARTOON NETWORK ʙʀᴀsɪʟ ᴴᴰ", "Cartoon Network FHD"],
    // One word changes what the channel is.
    ["UK: Comedy Central FHD", "Comedy Central Extra SD"],
    ["UK: BBC Four FHD", "Xumo: BBC Food"],
    ["UK: Sky Comedy FHD", "UK: Sky Cinema Comedy HD"],
    ["UK: U&Dave FHD", "UK: U&Dave Ja Vu SD"],
    ["UK: BBC One FHD", "UK: BBC Two FHD"],
  ];

  for (const [a, b] of different) {
    it(`"${a}" is not "${b}"`, () => {
      expect(suggests(a, b)).toBe(false);
    });
  }
});

describe("the EPG id", () => {
  it("matches channels whose names are written differently", () => {
    expect(
      suggests("UK: ITV1", "UK: ITV 1 FHD", ["ITV1London.uk", "ITV1London.uk"]),
    ).toBe(true);
    expect(
      suggests(
        "[Sky Stream] 102 BBC Two HD Network (England & Scotland)",
        "BBC Two",
        ["BBCTwo.uk", "BBCTwo.uk"],
      ),
    ).toBe(true);
  });

  it("is ignored when it's a placeholder shared by unrelated channels", () => {
    // Both of these carry "StreamingOnThisService.bossdummy" in the real data,
    // which says nothing about what they are.
    expect(
      suggests("UK: QVC", "US: MTV", [
        "StreamingOnThisService.bossdummy",
        "StreamingOnThisService.bossdummy",
      ]),
    ).toBe(false);
    expect(
      suggests("UK: BBC UHD", "US: NFL Network", ["Dummy", "Dummy"]),
    ).toBe(false);
  });

  it("beats a name match, so it lands at the top of the list", () => {
    const out = suggestPrimaries(
      [{ name: "UK: Sky Sports F1 UHD2", epgChannelId: "SkySportsF1UHD.uk" }],
      [
        { id: 1, name: "Sky Sports F1 FHD", epgChannelId: "SkySportsF1.uk" },
        { id: 2, name: "UK: Sky Sports F1 UHD", epgChannelId: "SkySportsF1UHD.uk" },
      ],
    );
    expect(out).toEqual([
      { id: 2, reason: "Same EPG id" },
      { id: 1, reason: "Same name" },
    ]);
  });
});

describe("suggestPrimaries", () => {
  const candidates = [
    { id: 1, name: "Sky Sports Main Event", epgChannelId: "SkySpME.uk" },
    { id: 2, name: "Sky Sports Football", epgChannelId: "SkySpF.uk" },
    { id: 3, name: "BBC One", epgChannelId: "BBCOne.uk" },
  ];

  it("takes the best score across everything you picked", () => {
    const out = suggestPrimaries(
      [
        { name: "Nothing Like It", epgChannelId: null },
        { name: "|UK| BBC ONE FHD", epgChannelId: null },
      ],
      candidates,
    );
    expect(out.map((s) => s.id)).toEqual([3]);
  });

  it("suggests nothing when nothing is close", () => {
    expect(suggests("Cartoon Network", "Sky Sports Main Event")).toBe(false);
    expect(suggestPrimaries([], candidates)).toEqual([]);
  });

  it("matches a renamed channel on the provider's name too", () => {
    const out = suggestPrimaries(
      [{ name: "UK: Sky Sports Main Event FHD2" }],
      [
        {
          id: 1,
          name: "Main Event",
          names: ["Main Event", "UK: Sky Sports Main Event FHD"],
        },
      ],
    );
    expect(out).toEqual([{ id: 1, reason: "Same name" }]);
  });

  it("offers at most five, best first", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: i + 1,
      name: `UK: Sky Sports Main Event FHD${i || ""}`,
    }));
    const out = suggestPrimaries([{ name: "Sky Sports Main Event" }], many);
    expect(out).toHaveLength(5);
  });
});

// The alt groups from a real playlist, as the alternate's provider name and the
// group it was filed under by hand.
describe("groups a real playlist was filed into by hand", () => {
  const primaries = [
    { id: 3, name: "Sky Sports F1 FHD", epgChannelId: "SkySportsF1.uk" },
    { id: 6, name: "UK: Sky Sports F1 UHD", epgChannelId: "SkySportsF1UHD.uk" },
    { id: 247, name: "UK: BBC UHD", epgChannelId: "COVID19" },
    { id: 249, name: "BBC Two", epgChannelId: "BBCTwo.uk" },
    { id: 251, name: "UK: Channel 4 FHD", epgChannelId: "Channel4.uk" },
    {
      id: 252,
      name: "UK: TNT Sport Ultimate UHD Long Name Long Name",
      names: [
        "UK: TNT Sport Ultimate UHD Long Name Long Name",
        "UK: TNT Sport Ultimate UHD",
      ],
      epgChannelId: "TNTSportsUltimate.uk",
    },
    {
      id: 257,
      name: "Sky Sports Main Event FHD",
      epgChannelId: "SkySportsMainEvent.uk",
    },
    { id: 260, name: "UK: TNT Sports 1 FHD", epgChannelId: "TNTSports1.uk" },
    { id: 261, name: "UK: TNT Sport 4 FHD", epgChannelId: "TNTSports4.uk" },
    { id: 262, name: "UK: TNT Sport 3 FHD", epgChannelId: "TNTSports3.uk" },
    { id: 264, name: "UK: TNT Sport 2 FHD", epgChannelId: "TNTSports2.uk" },
    {
      id: 265,
      name: "UK: Sky Sports Football FHD",
      epgChannelId: "SkySportsFootball.uk",
    },
    { id: 266, name: "BBC One", epgChannelId: "BBCOne.uk" },
    {
      id: 268,
      name: "Sky Sports Main Event UHD",
      epgChannelId: "SkySportsMainEventUHD.uk",
    },
    { id: 269, name: "Sky Sports UHD 2", epgChannelId: "SkySportsUltraHD2.uk" },
    {
      id: 271,
      name: "Sky Sports UHD 1 (Events Only)",
      epgChannelId: "SkySportsUltraHD.uk",
    },
    { id: 276, name: "ITV 1", epgChannelId: "ITV1London.uk" },
    { id: 278, name: "Sky Sports News FHD", epgChannelId: "SkySportsNews.uk" },
  ];

  // Each row: the stream being added, its EPG id, and the group it belongs in.
  const filed: [string, string, number][] = [
    ["UK: BBC One FHD", "BBCOneSouthEast.uk", 266],
    ["UK: TNT Sport Ultimate UHD2", "TNTSportsUltimate.uk", 252],
    ["UK: Sky Sports Main Event FHD2", "SkySportsMainEvent.uk", 257],
    ["UK: Sky Sports Main Event FHD", "SkySpMainEvHD.uk", 257],
    ["UK: TNT Sports 1 FHD 50FPS 5.1", "TNTSports1.uk", 260],
    ["UK: Sky Sports Main Event UHD", "SkySportsMainEventUHD.uk", 268],
    ["UK: Sky Sports UHD 2 (Events Only)", "SkySportsUltraHD2.uk", 269],
    ["UK: Sky Sports UHD 1 (Events Only) 2", "SkySportsUltraHD.uk", 271],
    ["UK: ITV1", "ITV1London.uk", 276],
    ["UK: Sky Sports News FHD (50FPS)", "SkySp.News.HD.uk", 278],
    ["[Sky Stream] 101 BBC One HD London", "BBCOne.uk", 266],
    ["[Sky Stream] 102 BBC Two HD Network (England & Scotland)", "BBCTwo.uk", 249],
  ];

  for (const [name, epg, want] of filed) {
    it(`puts "${name}" in group ${want}`, () => {
      const out = suggestPrimaries(
        [{ name, epgChannelId: epg }],
        primaries.filter((p) => p.name !== name),
      );
      expect(out[0]?.id).toBe(want);
    });
  }

  it("offers both F1 groups for a UHD copy, the same-EPG one first", () => {
    const out = suggestPrimaries(
      [{ name: "UK: Sky Sports F1 UHD2", epgChannelId: "SkySportsF1UHD.uk" }],
      primaries,
    );
    expect(out.map((s) => s.id)).toEqual([6, 3]);
  });
});
