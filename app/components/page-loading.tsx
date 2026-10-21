import { Loader2 } from "lucide-react";

/** Shown while a page's data loads on first open. */
export function PageLoading() {
  return (
    <div className="flex h-full min-h-40 items-center justify-center text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
    </div>
  );
}
