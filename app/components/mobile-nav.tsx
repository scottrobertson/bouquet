import { Menu } from "lucide-react";
import { createContext, useContext } from "react";
import { useMatches } from "react-router";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

// Opens the phone menu drawer. The app layout owns the drawer, and a screen that
// draws its own phone header puts this button in it.
export const MobileNavContext = createContext<() => void>(() => {});

// A screen sets `handle = { ownMobileHeader: true }` to hide the app's phone top
// bar, so a tall screen like the editor doesn't spend space on two headers.
export function useOwnMobileHeader() {
  return useMatches().some(
    (m) => (m.handle as { ownMobileHeader?: boolean } | undefined)?.ownMobileHeader,
  );
}

export function MobileNavButton({ className }: { className?: string }) {
  const open = useContext(MobileNavContext);
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("size-9", className)}
      aria-label="Menu"
      onClick={open}
    >
      <Menu className="size-5" />
    </Button>
  );
}
