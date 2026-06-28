import { Link, NavLink } from "react-router-dom";
import {
  Trophy,
  Vote,
  Shield,
  ChevronsLeft,
  ChevronsRight,
  Sun,
  Moon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useTheme } from "@/lib/theme";

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
}

const navItems: NavItem[] = [
  { to: "/upload", label: "Vote", icon: Vote },
  { to: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { to: "/admin", label: "Admin", icon: Shield },
];

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { theme, toggle: toggleTheme } = useTheme();

  return (
    <aside
      className="sticky top-0 z-10 hidden h-screen shrink-0 flex-col border-r bg-card transition-[width] duration-150 lg:flex"
      style={{ width: "var(--sidebar-w)" }}
    >
      {/* ─── Brand row ─────────────────────────────────────────────── */}
      <div className="flex h-14 items-center justify-between border-b px-3">
        <Link to="/" className="flex min-w-0 items-center gap-2 font-semibold">
          <img
            src="/favicon-32x32.png"
            alt=""
            aria-hidden
            className="h-7 w-7 shrink-0"
          />
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

      {/* ─── Nav (all entries get the same left-stripe treatment) ──── */}
      <nav className="flex flex-col gap-0.5 p-2 text-sm">
        {navItems.map((item) => (
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
        ))}
      </nav>

      {/* ─── Footer: theme toggle + version / collapse ─────────────── */}
      <div className="mt-auto border-t p-2">
        <button
          type="button"
          onClick={toggleTheme}
          title={
            collapsed
              ? theme === "dark"
                ? "Switch to light"
                : "Switch to dark"
              : undefined
          }
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            collapsed && "justify-center px-0",
          )}
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4 shrink-0" />
          ) : (
            <Moon className="h-4 w-4 shrink-0" />
          )}
          {!collapsed && (
            <span className="truncate">
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </span>
          )}
        </button>
        {collapsed ? (
          <button
            type="button"
            onClick={onToggle}
            className="mt-1 flex w-full items-center justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <ChevronsRight className="h-4 w-4" />
          </button>
        ) : (
          <div className="mt-1 px-2 py-1 text-xs text-muted-foreground">
            v0.1 · anon session
          </div>
        )}
      </div>
    </aside>
  );
}
