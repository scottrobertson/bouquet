import { Menu, Tv } from "lucide-react";
import { useState } from "react";
import { Outlet } from "react-router";
import { AppSidebar, SidebarContent } from "~/components/app-sidebar";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "~/components/ui/sheet";

// Pathless layout that wraps every in-app screen with the sidebar.
// Auth guards will live here later; for now everything is open.
export default function AppLayout() {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AppSidebar />
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
