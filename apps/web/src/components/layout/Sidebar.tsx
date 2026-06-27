import { Link, NavLink, useNavigate } from "react-router-dom";
import {
  Home,
  Trophy,
  Plus,
  Shield,
  Code2,
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

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

const navItems: { to: string; label: string; icon: LucideIcon }[] = [
  { to: "/", label: "Home", icon: Home },
  { to: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { to: "/admin", label: "Admin", icon: Shield },
  { to: "/dev", label: "API docs", icon: Code2 },
];

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const navigate = useNavigate();
  const { theme, toggle: toggleTheme } = useTheme();

  return (
    <aside
      className="sticky top-0 hidden h-screen shrink-0 flex-col border-r bg-card transition-[width] duration-150 lg:flex"
      style={{ width: "var(--sidebar-w)" }}
    >
      {/* ─── Brand row ─────────────────────────────────────────────── */}
      <div className="flex h-14 items-center justify-between border-b px-3">
        <Link to="/" className="flex min-w-0 items-center gap-2 font-semibold">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-foreground text-background text-[10px] font-bold">
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
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <ChevronsLeft className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* ─── Primary action ────────────────────────────────────────── */}
      <div className="p-2">
        <button
          type="button"
          onClick={() => navigate("/upload")}
          title={collapsed ? "Upload paper" : undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-md border bg-background px-2.5 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
            collapsed && "justify-center px-0",
          )}
        >
          <Plus className="h-4 w-4 shrink-0" />
          {!collapsed && <span className="truncate">Upload paper</span>}
        </button>
      </div>

      {/* ─── Secondary nav ─────────────────────────────────────────── */}
      <nav className="flex flex-col gap-0.5 px-2 pb-2 text-sm">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            title={collapsed ? item.label : undefined}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors hover:bg-accent hover:text-accent-foreground",
                isActive
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground",
                collapsed && "justify-center px-0",
              )
            }
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </NavLink>
        ))}
      </nav>

      {/* ─── Footer: theme + version ───────────────────────────────── */}
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
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
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
            className="mt-1 flex w-full items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
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
