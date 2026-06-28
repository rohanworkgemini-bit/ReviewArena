import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

/**
 * UI-only gate around a route. Renders children iff
 * `localStorage["reviewarena.adminToken"]` is non-empty; otherwise shows
 * a small "admin token required" pad.
 *
 * IMPORTANT: this is NOT real auth. The underlying APIs (admin endpoints
 * gated by Bearer ADMIN_TOKEN; review-gen by X-API-Key) enforce security
 * server-side regardless of this UI. This wrapper exists purely to hide
 * dev tooling from casual visitors landing on the production URL.
 */
const TOKEN_KEY = "reviewarena.adminToken";

export function RequireAdminToken({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string>(
    () => (typeof window === "undefined" ? "" : localStorage.getItem(TOKEN_KEY) ?? ""),
  );

  // Re-check on every storage event so unlocking on one tab unlocks others.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === TOKEN_KEY) setToken(e.newValue ?? "");
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  if (token) return <>{children}</>;

  return (
    <div className="container max-w-md py-16">
      <div className="rounded-lg border bg-card p-6">
        <h2 className="text-lg font-semibold tracking-tight">Admin only</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The developer playground is gated behind the admin token. Enter
          your ADMIN_TOKEN on the admin page to unlock it for this browser.
        </p>
        <div className="mt-4 flex gap-2">
          <Button asChild>
            <Link to="/admin">Go to admin → enter token</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
