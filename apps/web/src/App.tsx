import { Suspense, lazy, useEffect, useState, type CSSProperties } from "react";
import { BrowserRouter, Route, Routes, Navigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Header } from "@/components/layout/Header";
import { Sidebar } from "@/components/layout/Sidebar";
import { ErrorBoundary } from "@/components/ErrorBoundary";

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
const ApiDocsPage = lazy(() =>
  import("@/pages/ApiDocsPage").then((m) => ({ default: m.ApiDocsPage })),
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

export function App() {
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
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <div className="flex min-h-screen" style={layoutStyle}>
          <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
          <div className="flex min-w-0 flex-1 flex-col">
            <Header />
            <main className="flex-1">
              <ErrorBoundary>
                <Suspense fallback={<RouteFallback />}>
                  <Routes>
                    <Route path="/" element={<LandingPage />} />
                    <Route path="/leaderboard" element={<LeaderboardPage />} />
                    <Route path="/upload" element={<UploadPage />} />
                    <Route path="/scope" element={<ScopePage />} />
                    <Route path="/compare" element={<ComparisonPage />} />
                    <Route path="/reveal" element={<RevealPage />} />
                    <Route path="/admin" element={<AdminPage />} />
                    <Route path="/dev" element={<ApiDocsPage />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </Suspense>
              </ErrorBoundary>
            </main>
          </div>
        </div>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
