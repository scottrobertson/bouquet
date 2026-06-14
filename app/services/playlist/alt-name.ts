/** Build an alternate channel's display name from the playlist's template.
    {name} is the primary's resolved name, {n} the alternate's number (1-based). */
export function altName(template: string, primaryName: string, n: number): string {
  return template.replaceAll("{name}", primaryName).replaceAll("{n}", String(n));
}
