import { NavLink } from "react-router";
import {
  ListVideo,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  Settings,
  Tv,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";

const nav = [
  { to: "/sources", label: "Sources", icon: Radio },
  { to: "/playlists", label: "Playlists", icon: ListVideo },
  { to: "/settings", label: "Settings", icon: Settings },
];

/** The brand row and nav links. Shared by the desktop sidebar and the mobile
    drawer so there's one set of nav markup. onNavigate lets the drawer close.
    collapsed shrinks it to an icon rail; onToggle adds the collapse button. */
export function SidebarContent({
  onNavigate,
  collapsed = false,
  onToggle,
}: {
  onNavigate?: () => void;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  return (
    <>
      <div
        className={cn(
          "flex h-14 items-center gap-2",
          collapsed ? "justify-center px-2" : "px-4",
        )}
      >
        {!collapsed && (
          <>
            <div className="flex size-7 items-center justify-center rounded-md bg-primary/15 text-primary">
              <Tv className="size-4" />
            </div>
            <span className="text-sm font-semibold tracking-tight">
              Bouquet
            </span>
          </>
        )}

        {onToggle && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={cn(
              "text-muted-foreground hover:text-foreground",
              !collapsed && "ml-auto",
            )}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        )}
      </div>

      <nav
        className={cn(
          "flex flex-col gap-1 px-2 py-2 md:gap-0.5",
          collapsed && "items-center",
        )}
      >
        {nav.map((item) => {
          // Static className with aria-current variants instead of a render
          // function, so it survives the Tooltip's asChild Slot when collapsed.
          const link = (
            <NavLink
              to={item.to}
              onClick={onNavigate}
              className={cn(
                "group flex items-center gap-2.5 rounded-md text-[13px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.03] hover:text-foreground aria-[current=page]:bg-white/[0.06] aria-[current=page]:text-foreground",
                collapsed ? "size-9 justify-center" : "h-11 px-2.5 md:h-8",
              )}
            >
              <item.icon className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground group-aria-[current=page]:text-primary" />
              {!collapsed && item.label}
            </NavLink>
          );

          if (collapsed) {
            return (
              <Tooltip key={item.to}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{item.label}</TooltipContent>
              </Tooltip>
            );
          }

          return <div key={item.to}>{link}</div>;
        })}
      </nav>
    </>
  );
}

/** Desktop sidebar. Hidden on small screens, where the drawer takes over.
    Collapses to an icon rail when the user toggles it. */
export function AppSidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <aside
      className={cn(
        "hidden h-screen shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 ease-in-out md:flex",
        collapsed ? "w-[64px]" : "w-[240px]",
      )}
    >
      <SidebarContent collapsed={collapsed} onToggle={onToggle} />
    </aside>
  );
}
