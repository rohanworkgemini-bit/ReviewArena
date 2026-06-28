import { Suspense, lazy, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ParticleBackground } from "@/components/ParticleBackground";

// Code-split each route. The leaderboard pulls in recharts (~80 KB);
// the admin page is rarely visited; reveal pulls in radar deps. Lazy
// loading them keeps the first-paint bundle small for the upload flow.
//
// LandingPage is NOT lazy — it's the first paint for every new visitor;
// loading a Suspense fallback for the homepage looks broken.
import { LandingPage } from "@/pages/LandingPage";

const LeaderboardPage = lazy(() =>
  import("@/pages/LeaderboardPage").then((m) => ({ default: m.LeaderboardPage })),
);
const UploadPage = lazy(() =>
  import("@/pages/UploadPage").then((m) => ({ default: m.UploadPage })),
);
const ScopePage = lazy(() =>
  import("@/pages/ScopePage").then((m) => ({ default: m.ScopePage })),
);
const ComparisonPage = lazy(() =>
  import("@/pages/ComparisonPage").then((m) => ({ default: m.ComparisonPage })),
);
const RevealPage = lazy(() =>
  import("@/pages/RevealPage").then((m) => ({ default: m.RevealPage })),
);
const AdminPage = lazy(() =>
  import("@/pages/AdminPage").then((m) => ({ default: m.AdminPage })),
);

function RouteFallback() {
  // Page-level Suspense fallback. Single muted card so the layout
  // doesn't jump — the lazy chunks are usually <100 ms.
  return (
    <div className="container py-10">
      <div className="h-32 animate-pulse rounded-lg border bg-muted/20" />
    </div>
  );
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

const COLLAPSED_KEY = "sidebar-collapsed";
const EXPANDED_WIDTH = "14rem";
const COLLAPSED_WIDTH = "3.5rem";

// AppShell = the standard sidebar + header + main layout. Wrapped
// around every route EXCEPT "/" — the landing page is rendered
// full-bleed (no chrome) to read as a marketing surface, matching the
// Render-style dark hero design.
function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === "true";
  });

  useEffect(() => {
    window.localStorage.setItem(COLLAPSED_KEY, String(collapsed));
  }, [collapsed]);

  // --sidebar-w is consumed by Sidebar itself and by any sticky element
  // that needs to offset around the sidebar (e.g. the bottom vote bar on
  // /compare). Lives on the root layout div so every descendant inherits.
  const layoutStyle: CSSProperties = {
    ["--sidebar-w" as string]: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH,
  };

  return (
    <div className="relative flex min-h-screen" style={layoutStyle}>
      {/* App-wide drifting dot field — single fixed canvas behind
          everything. Theme-aware: dimmer dark-gray dots on light, white
          + violet on dark. Sidebar/Header/Cards sit above it at z-10. */}
      <ParticleBackground variant="fixed" />
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        <Header />
        <main className="flex-1">{children}</main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ErrorBoundary>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              {/* Full-bleed marketing page — no sidebar, no header. */}
              <Route path="/" element={<LandingPage />} />
              {/* Every other route runs inside the standard app shell. */}
              <Route
                path="/leaderboard"
                element={
                  <AppShell>
                    <LeaderboardPage />
                  </AppShell>
                }
              />
              <Route
                path="/upload"
                element={
                  <AppShell>
                    <UploadPage />
                  </AppShell>
                }
              />
              <Route
                path="/scope"
                element={
                  <AppShell>
                    <ScopePage />
                  </AppShell>
                }
              />
              <Route
                path="/compare"
                element={
                  <AppShell>
                    <ComparisonPage />
                  </AppShell>
                }
              />
              <Route
                path="/reveal"
                element={
                  <AppShell>
                    <RevealPage />
                  </AppShell>
                }
              />
              <Route
                path="/admin"
                element={
                  <AppShell>
                    <AdminPage />
                  </AppShell>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
