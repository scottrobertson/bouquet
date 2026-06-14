import type { ResolvedChannel } from "./queries.server";

// Strip double quotes so they can't break out of an EXTINF attribute.
function attr(value: string): string {
  return value.replace(/"/g, " ").trim();
}

export function buildM3u(rows: ResolvedChannel[], epgUrl: string): string {
  const lines: string[] = [`#EXTM3U url-tvg="${attr(epgUrl)}"`];

  for (const c of rows) {
    const name = attr(c.displayName);
    const catchup =
      c.catchupDays > 0
        ? ` catchup="default" catchup-days="${c.catchupDays}" catchup-source="${attr(
            c.catchupSource,
          )}"`
        : "";
    lines.push(
      `#EXTINF:-1 tvg-id="${attr(c.tvgId)}" tvg-name="${name}" tvg-logo="${attr(
        c.logo,
      )}" group-title="${attr(c.groupTitle)}"${catchup},${name}`,
    );
    lines.push(c.streamUrl);
  }

  return lines.join("\n") + "\n";
}
