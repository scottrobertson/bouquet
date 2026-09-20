export type AltNameInput = {
  /** The primary channel's resolved name. */
  name: string;
  /** The alternate's number, 1-based. */
  n: number;
  /** Name of the source (provider) the alternate's stream comes from. */
  provider: string;
};

/** Build an alternate channel's display name from the playlist's template.
    {name} is the primary's name, {n} the alternate number, {provider} the
    alternate's provider name and {provider_letter} its first letter. */
export function altName(template: string, input: AltNameInput): string {
  const provider = input.provider.trim();
  return template
    .replaceAll("{provider_letter}", provider.slice(0, 1).toUpperCase())
    .replaceAll("{provider}", provider)
    .replaceAll("{name}", input.name)
    .replaceAll("{n}", String(input.n));
}
