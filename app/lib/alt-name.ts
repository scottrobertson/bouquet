export type ChannelNameInput = {
  /** The channel's resolved name. */
  name: string;
  /** Name of the source (provider) the channel's stream comes from. */
  provider: string;
};

export type AltNameInput = {
  /** The primary channel's resolved name. */
  name: string;
  /** The alternate's number, 1-based. */
  n: number;
  /** Name of the source (provider) the alternate's stream comes from. */
  provider: string;
};

// One pass over the template, so a channel or provider name that happens to
// contain a placeholder like "{n}" is left alone.
function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? values[key] : match,
  );
}

function providerValues(provider: string) {
  const trimmed = provider.trim();
  return { provider: trimmed, provider_letter: trimmed.slice(0, 1).toUpperCase() };
}

/** Build a channel's output name from the playlist's channel template.
    {name} is the channel's own name, {provider} its provider name and
    {provider_letter} that name's first letter. */
export function channelName(template: string, input: ChannelNameInput): string {
  return fill(template, { name: input.name, ...providerValues(input.provider) });
}

/** Build an alternate channel's display name from the playlist's template.
    {name} is the primary's name, {n} the alternate number, {provider} the
    alternate's provider name and {provider_letter} its first letter. */
export function altName(template: string, input: AltNameInput): string {
  return fill(template, {
    name: input.name,
    n: String(input.n),
    ...providerValues(input.provider),
  });
}
