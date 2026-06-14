import { Menu, Tv } from "lucide-react";
import { useState } from "react";
import { Outlet } from "react-router";
import type { Route } from "./+types/_app";
import { AppSidebar, SidebarContent } from "~/components/app-sidebar";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "~/components/ui/sheet";

// Read the collapsed choice on the server so the sidebar renders at the right
// width before hydration, no flash.
export function loader({ request }: Route.LoaderArgs) {
  const cookie = request.headers.get("Cookie") ?? "";
  const collapsed = /(?:^|;\s*)sidebar_collapsed=1(?:;|$)/.test(cookie);
  return { sidebarCollapsed: collapsed };
}

// Pathless layout that wraps every in-app screen with the sidebar.
// Auth guards will live here later; for now everything is open.
export default function AppLayout({ loaderData }: Route.ComponentProps) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(loaderData.sidebarCollapsed);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      // Remember it so the next page load renders the same width.
      document.cookie = `sidebar_collapsed=${next ? 1 : 0}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AppSidebar collapsed={collapsed} onToggle={toggleCollapsed} />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar. Desktop uses the always-on sidebar instead. */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="size-9">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-64 p-0">
              <SheetTitle className="sr-only">Menu</SheetTitle>
              {/* Close the drawer when a link navigates. */}
              <SidebarContent onNavigate={() => setOpen(false)} />
            </SheetContent>
          </Sheet>
          <div className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Tv className="size-4" />
            </div>
            <span className="text-sm font-semibold tracking-tight">
              Bouquet
            </span>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
