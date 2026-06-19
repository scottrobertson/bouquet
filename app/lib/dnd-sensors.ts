import { PointerSensor, type PointerSensorOptions } from "@dnd-kit/core";
import type { PointerEvent as ReactPointerEvent } from "react";

/** A PointerSensor that only starts a drag when the pointer-down actually
    happened inside the draggable.

    Dialogs, popovers and menus render in a portal (outside the draggable in the
    DOM), but React still bubbles their events back up the component tree to the
    draggable's handler. So selecting text in a dialog over the board would start
    a drag. The draggable's node never contains a portaled target, so checking
    containment rules that out, for every overlay, without touching each one. */
export class SafePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (
        event: ReactPointerEvent,
        { onActivation }: PointerSensorOptions,
      ) => {
        const native = event.nativeEvent;
        if (!native.isPrimary || native.button !== 0) return false;
        const node = event.currentTarget;
        const target = native.target;
        if (
          node instanceof Node &&
          target instanceof Node &&
          !node.contains(target)
        ) {
          return false;
        }
        onActivation?.({ event: native });
        return true;
      },
    },
  ];
}
