import { createContext, useCallback, useContext } from "react";
import { channelName } from "~/services/playlist/alt-name";

/** The playlist's channel name template, so editor rows show the same name the
    player gets. */
export const ChannelNameTemplate = createContext("{name}");

export function useChannelName() {
  const template = useContext(ChannelNameTemplate);
  return useCallback(
    (name: string, provider: string) => channelName(template, { name, provider }),
    [template],
  );
}
