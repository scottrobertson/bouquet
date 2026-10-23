import { useSyncExternalStore } from "react";

const query = "(pointer: coarse)";

function subscribe(onChange: () => void) {
  const list = window.matchMedia(query);
  list.addEventListener("change", onChange);
  return () => list.removeEventListener("change", onChange);
}

/** True on a touch screen, where a tap is less precise than a mouse click and
    is easy to make by accident while scrolling. */
export function useCoarsePointer() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
