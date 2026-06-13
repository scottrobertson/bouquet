import { NavLink } from "react-router";
import { ListVideo, Radio, Settings, Tv } from "lucide-react";
import { cn } from "~/lib/utils";

const nav = [
  { to: "/sources", label: "Sources", icon: Radio },
  { to: "/playlists", label: "Playlists", icon: ListVideo },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppSidebar() {
  return (
    <aside className="flex h-screen w-[240px] shrink-0 flex-col border-r border-border bg-sidebar">
      <div className="flex h-14 items-center gap-2 px-4">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary/15 text-primary">
          <Tv className="size-4" />
        </div>
        <span className="text-sm font-semibold tracking-tight">
          IPTV Manager
        </span>
      </div>

      <nav className="flex flex-col gap-0.5 px-2 py-2">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
                isActive
                  ? "bg-white/[0.06] text-foreground"
                  : "text-muted-foreground hover:bg-white/[0.03] hover:text-foreground",
              )
            }
          >
            {({ isActive }) => (
              <>
                <item.icon
                  className={cn(
                    "size-4 shrink-0 transition-colors",
                    isActive
                      ? "text-primary"
                      : "text-muted-foreground group-hover:text-foreground",
                  )}
                />
                {item.label}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
