import { Link, NavLink } from "react-router-dom";
import { Trophy, Upload, Shield } from "lucide-react";
import { cn } from "@/lib/cn";

// No standalone "Compare" entry — /compare requires a paperId in the URL,
// so it can only be reached by uploading a paper first: submit content →
// land directly on the comparison view.
const navItems = [
  { to: "/leaderboard", label: "Leaderboard", icon: Trophy },
  { to: "/upload", label: "Upload paper", icon: Upload },
  { to: "/admin", label: "Admin", icon: Shield },
];

// Mobile-only top bar — on lg+ the Sidebar handles nav instead. Kept as
// a separate component so the lg+ flex layout stays clean.
export function Header() {
  return (
    <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/70 lg:hidden">
      <div className="container flex h-14 items-center justify-between gap-4">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-foreground text-background text-[10px] font-bold">
            RA
          </span>
          <span className="hidden sm:inline">ReviewArena</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors hover:bg-accent hover:text-accent-foreground",
                  isActive && "bg-accent text-accent-foreground",
                )
              }
            >
              <item.icon className="h-4 w-4" />
              <span className="hidden sm:inline">{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </header>
  );
}
