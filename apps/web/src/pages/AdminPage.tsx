import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

// Minimal admin UI for the thesis demo. Single concern: list / toggle /
// delete review systems. Everything else (CSV export, score replay) stays
// curl-only so we don't grow this into a full ops dashboard.
//
// The admin token is bearer-auth on the API side; we just stash it in
// localStorage so the operator doesn't paste it every page load. NOT a
// production session model — this is a single-tenant thesis app.

const TOKEN_KEY = "reviewarena.adminToken";

interface ReviewSystemRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  adapterKey: string;
  enabled: boolean;
  createdAt: string;
}

async function adminFetch<T>(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
    },
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function AdminPage() {
  const [token, setToken] = useState<string>(
    () => localStorage.getItem(TOKEN_KEY) ?? "",
  );
  useEffect(() => {
    if (token) localStorage.setItem(TOKEN_KEY, token);
  }, [token]);

  const qc = useQueryClient();

  const systemsQuery = useQuery({
    queryKey: ["admin", "systems"],
    queryFn: () => adminFetch<ReviewSystemRow[]>("/admin/review-systems", token),
    enabled: token.length > 0,
    retry: false,
  });

  const toggleMutation = useMutation({
    mutationFn: (id: string) =>
      adminFetch<ReviewSystemRow>(`/admin/review-systems/${id}/toggle`, token, {
        method: "POST",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "systems"] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      adminFetch<void>(`/admin/review-systems/${id}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "systems"] }),
  });

  return (
    <div className="container max-w-4xl py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Admin</h1>
        <p className="text-muted-foreground mt-1">
          Manage review systems. Toggle to enable / disable; delete only if the
          system has never produced a review.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Admin token</CardTitle>
          <CardDescription>
            Bearer token from ADMIN_TOKEN in .env. Stored in localStorage, not
            sent to anything but this app's API.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <input
            type="password"
            placeholder="paste ADMIN_TOKEN here"
            value={token}
            onChange={(e) => setToken(e.target.value.trim())}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Review systems</CardTitle>
          <CardDescription>
            Source of truth for which adapters fan out on each upload.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!token && (
            <div className="text-sm text-muted-foreground">
              Enter the admin token above to load the systems table.
            </div>
          )}
          {token && systemsQuery.isLoading && (
            <div className="text-sm text-muted-foreground">Loading…</div>
          )}
          {token && systemsQuery.error && (
            <div className="text-sm text-destructive">
              {String(systemsQuery.error)}
            </div>
          )}
          {systemsQuery.data && (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Slug</th>
                  <th className="py-2 pr-3 font-medium">Name</th>
                  <th className="py-2 pr-3 font-medium">Adapter</th>
                  <th className="py-2 pr-3 font-medium">Enabled</th>
                  <th className="py-2 pr-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {systemsQuery.data.map((s) => (
                  <tr key={s.id} className="border-b">
                    <td className="py-2 pr-3 font-mono text-xs">{s.slug}</td>
                    <td className="py-2 pr-3">{s.name}</td>
                    <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                      {s.adapterKey}
                    </td>
                    <td className="py-2 pr-3">
                      {s.enabled ? (
                        <Badge>enabled</Badge>
                      ) : (
                        <Badge variant="outline">disabled</Badge>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => toggleMutation.mutate(s.id)}
                          disabled={toggleMutation.isPending}
                        >
                          {s.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete ${s.slug}? This only works if no reviews reference it.`,
                              )
                            ) {
                              deleteMutation.mutate(s.id);
                            }
                          }}
                          disabled={deleteMutation.isPending}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {deleteMutation.error && (
            <div className="mt-3 text-sm text-destructive">
              {String(deleteMutation.error)}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
