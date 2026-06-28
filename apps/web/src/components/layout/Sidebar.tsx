import { Link, NavLink } from "react-router-dom";
import {
  Trophy,
  Vote,
  Shield,
  ChevronsLeft,
  ChevronsRight,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

// Persistent left rail. Only rendered on lg+ — small screens get the
// fallback Header (top bar). Width is driven by the CSS variable
// --sidebar-w on the layout root so sticky bottom bars on /compare and
// /upload can offset themselves without prop drilling.
//
// Visual language tracks the design tokens so it adapts between light
// and dark mode automatically. The brand mark + Vote pill stay violet
// in both modes (brand is mode-independent). The active nav item uses
// a violet left-accent stripe + subtle `accent` fill in both modes.

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  // Primary entries render as a solid violet pill; secondary entries
  // get the standard left-stripe NavLink treatment. Only one primary
  // entry expected — used for the Vote CTA.
  primary?: boolean;
}

const navItems: NavItem[] = [
  { to: "/upload", label: "Vote", icon: Vote, primary: true },
  { to: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { to: "/admin", label: "Admin", icon: Shield },
];

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside
      className="sticky top-0 z-10 hidden h-screen shrink-0 flex-col border-r bg-card transition-[width] duration-150 lg:flex"
      style={{ width: "var(--sidebar-w)" }}
    >
      {/* ─── Brand row ─────────────────────────────────────────────── */}
      <div className="flex h-14 items-center justify-between border-b px-3">
        <Link to="/" className="flex min-w-0 items-center gap-2 font-semibold">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-500 text-[10px] font-bold text-white">
            RA
          </span>
          {!collapsed && (
            <span className="truncate tracking-tight">ReviewArena</span>
          )}
        </Link>
        {!collapsed && (
          <button
            type="button"
            onClick={onToggle}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <ChevronsLeft className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ─── Nav (single ordered list; Vote rendered as violet pill) ─ */}
      <nav className="flex flex-col gap-0.5 p-2 text-sm">
        {navItems.map((item) =>
          item.primary ? (
            <NavLink
              key={item.to}
              to={item.to}
              title={collapsed ? item.label : undefined}
              // Solid violet pill, always — including when active.
              className={cn(
                "flex items-center gap-2 rounded-md bg-violet-500 px-2.5 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-400",
                collapsed && "justify-center px-0",
              )}
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          ) : (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              title={collapsed ? item.label : undefined}
              className={({ isActive }) =>
                cn(
                  // Violet left-accent stripe on the active item —
                  // visible via border-l-2, transparent when inactive
                  // so the row width stays constant.
                  "flex items-center gap-2 rounded-md border-l-2 border-transparent px-2.5 py-1.5 transition-colors hover:bg-accent hover:text-foreground",
                  isActive
                    ? "border-violet-500 bg-accent font-medium text-foreground"
                    : "text-muted-foreground",
                  collapsed && "justify-center border-l-0 px-0",
                )
              }
            >
              <item.icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          ),
        )}
      </nav>

      {/* ─── Footer: version / collapse toggle ─────────────────────── */}
      <div className="mt-auto border-t p-2">
        {collapsed ? (
          <button
            type="button"
            onClick={onToggle}
            className="flex w-full items-center justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
        ) : (
          <div className="px-2 py-1 text-xs text-muted-foreground">
            v0.1 · anon session
          </div>
        )}
      </div>
    </aside>
  );
}
