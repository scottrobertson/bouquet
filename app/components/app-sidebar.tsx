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

// lucide dropped its brand icons, so the GitHub mark is inline.
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58v-2.03c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.11-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6.01 0c2.29-1.55 3.3-1.23 3.3-1.23.65 1.66.24 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z" />
    </svg>
  );
}

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

      <div
        className={cn(
          "mt-auto px-2 py-3",
          collapsed && "flex justify-center",
        )}
      >
        {(() => {
          const repo = (
            <a
              href="https://github.com/scottrobertson/bouquet"
              target="_blank"
              rel="noreferrer"
              onClick={onNavigate}
              aria-label="View Bouquet on GitHub"
              className={cn(
                "flex items-center gap-2.5 rounded-md text-[13px] font-medium text-muted-foreground transition-colors hover:bg-white/[0.03] hover:text-foreground",
                collapsed ? "size-9 justify-center" : "h-8 px-2.5",
              )}
            >
              <GithubIcon className="size-4 shrink-0" />
              {!collapsed && "GitHub"}
            </a>
          );

          if (collapsed) {
            return (
              <Tooltip>
                <TooltipTrigger asChild>{repo}</TooltipTrigger>
                <TooltipContent side="right">GitHub</TooltipContent>
              </Tooltip>
            );
          }

          return repo;
        })()}
      </div>
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
