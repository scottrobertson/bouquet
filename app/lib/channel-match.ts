/** Guesses which playlist channel a stream belongs under, so the "add as
    alternate of…" pickers can offer the right group instead of making you type
    the name out.

    Two streams are the same channel when the provider gives them the same EPG
    id, or when their names match once the provider's noise is stripped off (a
    country tag, a quality suffix, a copy number). Every rule below is here
    because real provider names needed it, and the tests carry those names. */

// Providers decorate names with lookalike letters to make their list stand out:
// "ᴴᴰ" for HD, "ʙʀᴀsɪʟ" for Brasil. Unicode's own conversion handles the
// superscripts; the small capitals it leaves alone, so they're listed here.
const SMALL_CAPS_FROM = "ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘꞯʀꜱᴛᴜᴠᴡʏᴢ";
const SMALL_CAPS_TO = "abcdefghijklmnopqrstuvwyz";

// Words that say how a stream is encoded rather than what channel it is. Both
// names lose these before they're compared. Kept as one regex so they go before
// digits are split off, otherwise "4K" would become "4 K".
const NOISE =
  /\b(fhd|uhd|shd|qhd|hd|hq|sd|ld|hdr|4k|8k|2k|h264|h265|x264|x265|hevc|avc|mpeg2|raw|vip|backup|bk|alt|alternate|multi)\b/g;

// Country and region tags, which providers put at the front of a name. Two
// channels tagged with different countries are different channels, however alike
// the rest of the name looks: "US: TNT" is not "BRA: TNT HD".
const COUNTRIES = new Set([
  "ae", "af", "al", "alb", "ar", "arg", "at", "au", "aus", "be", "bg", "bih",
  "bol", "br", "bra", "by", "ca", "can", "ch", "chl", "cl", "cm", "cn", "co",
  "col", "cr", "cu", "cy", "cz", "cze", "de", "dk", "do", "dz", "ec", "ecu",
  "ee", "eg", "es", "esp", "fi", "fr", "fra", "gb", "ge", "gh", "gr", "gre",
  "gt", "hk", "hn", "hr", "hu", "id", "ie", "il", "in", "ind", "ir", "iq",
  "is", "it", "ita", "jp", "ke", "kr", "kw", "kz", "lb", "lt", "lu", "lv",
  "ly", "ma", "mk", "mx", "my", "ng", "nl", "no", "np", "nz", "pa", "pe",
  "per", "ph", "pk", "pak", "pl", "pol", "pr", "pt", "por", "py", "qa", "ro",
  "rom", "rs", "ru", "rus", "sa", "se", "sg", "si", "sk", "srb", "sv", "th",
  "tn", "tr", "tur", "tw", "ua", "ug", "uk", "us", "usa", "uy", "ve", "ven",
  "vn", "za",
]);

/** A channel name pulled apart into the bits the matcher compares. */
export type ChannelKey = {
  // The name with the provider's noise stripped off.
  name: string;
  // The country tag it was labelled with, when we recognise one.
  country: string | null;
  // How many hours behind the parent channel this one runs, from a "+1" in the
  // name. Null when it isn't a timeshift channel.
  timeshift: string | null;
  // Numbers left in the name, sorted, which are what separate one channel in a
  // family from the next ("Sky Sports 1" vs "Sky Sports 2").
  numbers: string[];
};

/** Strips a channel name down to just the channel, so the same channel from two
    providers comes out identical. "UK: Sky Sports Main Event FHD" and
    "|UK| SKY SPORTS MAIN EVENT ᴴᴰ" both become "sky sports main event". */
export function normaliseChannelName(name: string): string {
  return channelKey(name).name;
}

// Pulling a name apart is the slow half of a suggestion, and the editor asks for
// suggestions again on every click of a checkbox, over the same playlist names
// each time. Names are stable strings, so the answer can just be kept.
const KEY_CACHE = new Map<string, ChannelKey>();
const KEY_CACHE_LIMIT = 50_000;

export function channelKey(raw: string): ChannelKey {
  const cached = KEY_CACHE.get(raw);
  if (cached) return cached;
  const key = parseName(raw);
  if (KEY_CACHE.size < KEY_CACHE_LIMIT) KEY_CACHE.set(raw, key);
  return key;
}

function parseName(raw: string): ChannelKey {
  // NFKD turns the decorated letters into plain ones and splits accents off, so
  // the accents can be dropped.
  let s = raw.normalize("NFKD").replace(/\p{M}/gu, "");
  s = s.replace(/[^\0-\x7F]/gu, (ch) => {
    const i = SMALL_CAPS_FROM.indexOf(ch);
    return i >= 0 ? SMALL_CAPS_TO[i] : ch;
  });
  s = s.toLowerCase();

  // A leading tag in brackets or pipes is the provider's own labelling, like
  // "|UK|" or "[Sky Stream]".
  let tag: string | null = null;
  s = s.replace(/^\s*[[(|{]\s*([^\])|}]{1,20}?)\s*[\])|}]\s*/, (_, t: string) => {
    tag = t;
    return "";
  });
  // A short prefix before a colon, dash or pipe is a country or region, like
  // "UK:", "US -" or "D2H|". Anything longer is part of the name ("Sky Sports:
  // Main Event").
  s = s.replace(/^\s*([a-z0-9]{2,4})\s*(?::|\||-\s)\s*/, (_, t: string) => {
    tag ??= t;
    return "";
  });

  // Frame rate, resolution and surround sound.
  s = s.replace(/\b\d{2,3}\s*fps\b/g, " ");
  s = s.replace(/\b(2160|1080|720|576|480)\s*[pi]?\b/g, " ");
  s = s.replace(/\b[57][.\s]1\b/g, " ");
  // Providers number their duplicates by tacking a digit onto the quality, like
  // "FHD2" and "UHD3". The digit is which copy it is, not which channel.
  s = s.replace(/\b([fusq]?hd|[248]k)\d\b/g, " ");
  s = s.replace(NOISE, " ");

  // "+1" and "+24" are the timeshifted version of a channel, an hour or a day
  // behind, which is a different channel to its parent. Checked after the frame
  // rate is gone so "Sky Sports+ 50FPS" doesn't read as a timeshift.
  let timeshift: string | null = null;
  s = s.replace(/\+\s*(\d{1,2})\b/, (_, t: string) => {
    timeshift = t;
    return " ";
  });

  // "ITV2" and "ITV 2" are the same channel, so split letters from digits. This
  // runs after the quality words are gone, so "4K" is never split.
  s = s.replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2");

  // Everything that isn't a letter or number is a separator, so punctuation
  // never decides whether two names match.
  s = s.replace(/[^a-z0-9]+/g, " ");

  const words = s.split(" ").filter(Boolean);
  const country = tag && COUNTRIES.has(tag) ? tag : null;
  return {
    name: words.join(" "),
    country,
    timeshift,
    numbers: words
      .filter((w) => /^\d+$/.test(w))
      .map((w) => String(Number(w)))
      .sort(),
  };
}

/** Overlapping three-character chunks, padded so the start and end of the name
    count too. */
function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** How alike two names are, 0 to 1. Comparing chunks rather than whole words
    means an abbreviation or a typo still scores well. */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

// Below this the guess is more distracting than useful. It only has to catch
// names that are written differently, like "ESPNU" and "ESPN U", because the
// checks in matchScore already rule out the channels that merely look alike.
const THRESHOLD = 0.58;

// A shared EPG id is enough on its own, but some providers give hundreds of
// unrelated channels the same placeholder id, so the names still have to be in
// the same postcode.
const EPG_NAME_FLOOR = 0.2;

const MAX_SUGGESTIONS = 5;

/** Whether two words are the same word: written the same, one an abbreviation of
    the other ("sp" for "sports"), or close enough to be a typo. */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (short.length >= 2 && long.startsWith(short)) return true;
  return nameSimilarity(a, b) >= 0.7;
}

// A single letter never decides which channel it is, so it doesn't count as the
// odd one out: the "U" in "U&Alibi", or the "U" in "ESPN U".
const MINOR_WORD = 1;

/** Whether both names are made of the same words. Comparing whole words catches
    what a chunk-by-chunk score misses: "Sky Sports Cricket" and "Sky Sports
    Golf" only differ by their last word, but they're different channels. */
function sameWords(a: string, b: string): boolean {
  const wa = a.split(" ").filter(Boolean);
  const wb = b.split(" ").filter(Boolean);
  const unmatched = (from: string[], to: string[]) =>
    from.some((w) => w.length > MINOR_WORD && !to.some((o) => sameWord(w, o)));
  return !unmatched(wa, wb) && !unmatched(wb, wa);
}

/** How likely two names are the same channel, 0 to 1. Zero when something rules
    it out outright: a different country tag, one being a "+1" of the other,
    different numbers in the name (which is what tells "TNT Sports 1" from "TNT
    Sports 2"), or a word in one name that the other doesn't have. */
export function matchScore(a: ChannelKey, b: ChannelKey): number {
  if (a.country && b.country && a.country !== b.country) return 0;
  if (a.timeshift !== b.timeshift) return 0;
  if (a.numbers.join() !== b.numbers.join()) return 0;
  if (!sameWords(a.name, b.name)) return 0;
  return nameSimilarity(a.name, b.name);
}

export type MatchTarget = { name: string; epgChannelId?: string | null };

export type MatchCandidate = {
  id: number;
  name: string;
  // Other names worth matching on, like the provider's own name for a channel
  // you've renamed. Defaults to just `name`.
  names?: string[];
  epgChannelId?: string | null;
};

export type Suggestion = { id: number; reason: string };

function cleanEpgId(id: string | null | undefined): string {
  return (id ?? "").trim().toLowerCase();
}

/** The playlist channels most likely to be the right group for the channels you
    picked, best first. Scores every candidate against every picked channel and
    keeps its best score, so selecting three copies of the same channel still
    lands on one answer. */
export function suggestPrimaries<T extends MatchCandidate>(
  picked: MatchTarget[],
  candidates: T[],
  limit = MAX_SUGGESTIONS,
): Suggestion[] {
  if (picked.length === 0) return [];

  const pickedKeys = picked.map((p) => channelKey(p.name));
  const pickedEpgIds = new Set(
    picked.map((p) => cleanEpgId(p.epgChannelId)).filter(Boolean),
  );

  const scored: { id: number; score: number; reason: string }[] = [];
  for (const c of candidates) {
    // A renamed channel is matched on both its new name and the provider's, so
    // renaming it to something short doesn't lose the match.
    const keys = (c.names ?? [c.name]).map(channelKey);

    let best = 0;
    let loose = 0;
    for (const key of keys) {
      for (const p of pickedKeys) {
        best = Math.max(best, matchScore(key, p));
        loose = Math.max(loose, nameSimilarity(key.name, p.name));
      }
    }

    const epgId = cleanEpgId(c.epgChannelId);
    if (epgId && pickedEpgIds.has(epgId) && loose >= EPG_NAME_FLOOR) {
      scored.push({ id: c.id, score: 2, reason: "Same EPG id" });
      continue;
    }
    if (best < THRESHOLD) continue;
    scored.push({
      id: c.id,
      score: best,
      reason: best === 1 ? "Same name" : "Similar name",
    });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ id, reason }) => ({ id, reason }));
}
