import { Link } from "react-router-dom";

// Site-wide footer. Same component on the landing page and inside the
// AppShell so the chrome is consistent across the app. Uses design
// tokens (border / muted-foreground / foreground) so it tracks the
// theme — currently dark-only, but the tokens would adapt if light
// mode is reintroduced.
//
// The footer sits at the bottom of the page's normal flow (not fixed
// or sticky) — it appears once the user scrolls to the end of the
// content. On short pages it naturally hugs the viewport bottom thanks
// to AppShell's flex layout (main is flex-1).
export function Footer() {
  return (
    <footer className="border-t bg-card/40 backdrop-blur-sm">
      <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-3 px-6 py-6 text-xs text-muted-foreground md:flex-row md:items-center">
        <div className="flex items-center gap-2">
          <img src="/favicon-32x32.png" alt="" aria-hidden className="h-4 w-4" />
          <span>ReviewArena · thesis build · single-tenant</span>
        </div>
        <div className="flex items-center gap-5">
          <Link to="/leaderboard" className="transition-colors hover:text-foreground">
            Leaderboard
          </Link>
          <Link to="/admin" className="transition-colors hover:text-foreground">
            Admin
          </Link>
          <a
            href="https://github.com/rohanworkgemini/review-arena"
            target="_blank"
            rel="noreferrer noopener"
            className="transition-colors hover:text-foreground"
          >
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
