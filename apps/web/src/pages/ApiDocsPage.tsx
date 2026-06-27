import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import {
  ENDPOINTS,
  SECTIONS,
  type ApiEndpoint,
  type ApiParam,
  type ApiSection,
} from "@/lib/api-catalog";
import { ReviewerPlayground } from "@/components/ReviewerPlayground";

const SECTION_ORDER: ApiSection[] = [
  "node-public",
  "node-admin",
  "review-gen",
  "modal",
];

const METHOD_STYLES: Record<ApiEndpoint["method"], string> = {
  GET: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  POST: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  PUT: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  DELETE: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
};

export function ApiDocsPage() {
  const [filter, setFilter] = useState("");
  const [activeSections, setActiveSections] = useState<Set<ApiSection>>(
    () => new Set(SECTION_ORDER),
  );

  const grouped = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return SECTION_ORDER.map((section) => ({
      section,
      meta: SECTIONS[section],
      endpoints: ENDPOINTS.filter((e) => e.section === section).filter((e) => {
        if (!needle) return true;
        return (
          e.path.toLowerCase().includes(needle) ||
          e.summary.toLowerCase().includes(needle) ||
          (e.tags ?? []).some((t) => t.includes(needle))
        );
      }),
    }));
  }, [filter]);

  const toggleSection = (s: ApiSection) =>
    setActiveSections((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  return (
    <div className="container max-w-5xl py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">API surface</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every HTTP endpoint ReviewArena exposes — public, admin, the
          Python review-gen service, and the Modal-hosted GPU services.
          Use the <kbd className="rounded border bg-muted px-1.5 py-0.5 text-xs">Try it</kbd>{" "}
          button on GET endpoints to call them live; POSTs / SSE show a
          curl snippet instead.
        </p>
      </div>

      <ReviewerPlayground />

      <div className="sticky top-12 z-10 -mx-2 flex flex-col gap-3 border-b bg-background/95 px-2 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 lg:top-12">
        <input
          type="search"
          placeholder="Filter by path, summary, or tag…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <div className="flex flex-wrap gap-2">
          {SECTION_ORDER.map((s) => {
            const active = activeSections.has(s);
            const count = ENDPOINTS.filter((e) => e.section === s).length;
            return (
              <button
                key={s}
                type="button"
                onClick={() => toggleSection(s)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs transition-colors",
                  active
                    ? "bg-foreground text-background"
                    : "bg-card text-muted-foreground hover:bg-muted",
                )}
              >
                {SECTIONS[s].label}{" "}
                <span className="font-mono">({count})</span>
              </button>
            );
          })}
        </div>
      </div>

      {grouped
        .filter((g) => activeSections.has(g.section))
        .filter((g) => g.endpoints.length > 0)
        .map(({ section, meta, endpoints }) => (
          <section key={section} className="space-y-3">
            <div className="border-b pb-2">
              <h2 className="text-lg font-semibold">{meta.label}</h2>
              <p className="font-mono text-xs text-muted-foreground">
                {meta.baseHint}
              </p>
            </div>
            <div className="space-y-3">
              {endpoints.map((e, i) => (
                <EndpointCard key={`${e.section}-${e.path}-${e.method}-${i}`} ep={e} />
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}

// ─── Per-endpoint card ─────────────────────────────────────────────────────

function EndpointCard({ ep }: { ep: ApiEndpoint }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader className="cursor-pointer" onClick={() => setOpen((v) => !v)}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Badge
              className={cn(
                "font-mono text-[10px] font-bold uppercase",
                METHOD_STYLES[ep.method],
              )}
              variant="outline"
            >
              {ep.method}
            </Badge>
            <code className="truncate font-mono text-sm">{ep.path}</code>
          </div>
          <div className="flex items-center gap-2">
            {(ep.tags ?? []).map((t) => (
              <span
                key={t}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
              >
                {t}
              </span>
            ))}
            <span className="text-xs text-muted-foreground">{open ? "−" : "+"}</span>
          </div>
        </div>
        <CardDescription className="pt-1">{ep.summary}</CardDescription>
      </CardHeader>
      {open && (
        <CardContent className="space-y-4 text-sm">
          <p className="text-muted-foreground">{ep.description}</p>
          {ep.params && ep.params.length > 0 && <ParamsTable params={ep.params} />}
          {ep.responseNote && (
            <p className="rounded-md border border-amber-500/30 bg-amber-50 px-3 py-2 text-xs dark:bg-amber-950/30">
              <strong>Response:</strong> {ep.responseNote}
            </p>
          )}
          <ActionRow ep={ep} />
        </CardContent>
      )}
    </Card>
  );
}

function ParamsTable({ params }: { params: ApiParam[] }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Parameters
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-1 pr-3 font-mono font-medium">name</th>
            <th className="py-1 pr-3 font-medium">in</th>
            <th className="py-1 pr-3 font-medium">req</th>
            <th className="py-1 font-medium">description</th>
          </tr>
        </thead>
        <tbody>
          {params.map((p) => (
            <tr key={`${p.in}-${p.name}`} className="border-b last:border-0">
              <td className="py-1 pr-3 font-mono">{p.name}</td>
              <td className="py-1 pr-3 text-muted-foreground">{p.in}</td>
              <td className="py-1 pr-3">
                {p.required ? (
                  <span className="text-rose-500">●</span>
                ) : (
                  <span className="text-muted-foreground">○</span>
                )}
              </td>
              <td className="py-1">
                {p.description}
                {p.example && (
                  <span className="ml-2 font-mono text-muted-foreground">
                    e.g. {p.example}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActionRow({ ep }: { ep: ApiEndpoint }) {
  // Safe, testable from the browser:
  //   - All safe Node GETs (proxied via /api → :8000)
  //   - All safe review-gen endpoints (proxied via /py-api → :8001),
  //     including multipart POST /parse for live PDF testing.
  if (ep.safe && (ep.section === "node-public" || ep.section === "node-admin")) {
    if (ep.method === "GET") return <TryItForm ep={ep} />;
  }
  if (ep.safe && ep.section === "review-gen") {
    return <TryItForm ep={ep} />;
  }
  return <CurlSnippet ep={ep} />;
}

// ─── "Try it" form ─────────────────────────────────────────────────────────
// Handles three input shapes:
//   - path/query params (text inputs)
//   - body params named "file" → multipart file picker
//   - other body params → text inputs collected into a JSON object
//
// Routes the request to the right base URL:
//   - node-public / node-admin  → /api (Vite proxy → :8000)
//   - review-gen                 → /py-api (Vite proxy → :8001)

const BASE_FOR_SECTION: Record<ApiEndpoint["section"], string> = {
  "node-public": "/api",
  "node-admin": "/api",
  "review-gen": "/py-api",
  modal: "", // not used — Modal endpoints fall through to CurlSnippet
};

function TryItForm({ ep }: { ep: ApiEndpoint }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [resp, setResp] = useState<{ status: number; body: string; mime: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const pathParams = (ep.params ?? []).filter((p) => p.in === "path");
  const queryParams = (ep.params ?? []).filter((p) => p.in === "query");
  const fileBodyParam = (ep.params ?? []).find((p) => p.in === "body" && p.name === "file");
  const jsonBodyParams = (ep.params ?? []).filter(
    (p) => p.in === "body" && p.name !== "file",
  );

  const buildUrl = () => {
    let url = ep.path;
    for (const p of pathParams) {
      const v = values[p.name] ?? "";
      url = url.replace(`:${p.name}`, encodeURIComponent(v));
    }
    const qs = new URLSearchParams();
    for (const p of queryParams) {
      const v = values[p.name];
      if (v) qs.set(p.name, v);
    }
    const qsStr = qs.toString();
    return `${BASE_FOR_SECTION[ep.section]}${url}${qsStr ? "?" + qsStr : ""}`;
  };

  const run = async () => {
    setLoading(true);
    setResp(null);
    try {
      const init: RequestInit = { method: ep.method, credentials: "include" };

      if (fileBodyParam) {
        if (!file) {
          setResp({ status: 0, body: "Pick a file first.", mime: "" });
          return;
        }
        const fd = new FormData();
        fd.append(fileBodyParam.name, file);
        // Also append non-file body params as form fields (rare but possible).
        for (const p of jsonBodyParams) {
          const v = values[p.name];
          if (v) fd.append(p.name, v);
        }
        init.body = fd;
        // Don't set content-type — the browser writes the multipart
        // boundary header itself.
      } else if (jsonBodyParams.length > 0) {
        const body: Record<string, unknown> = {};
        for (const p of jsonBodyParams) {
          const v = values[p.name];
          if (v) body[p.name] = v;
        }
        init.body = JSON.stringify(body);
        init.headers = { "content-type": "application/json" };
      }

      const r = await fetch(buildUrl(), init);
      const mime = r.headers.get("content-type") ?? "";
      const text = await r.text();
      let pretty = text;
      if (mime.includes("application/json") || text.trim().startsWith("{")) {
        try {
          pretty = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          /* leave as-is */
        }
      }
      setResp({ status: r.status, body: pretty, mime });
    } catch (e) {
      setResp({
        status: 0,
        body: e instanceof Error ? e.message : String(e),
        mime: "",
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      {[...pathParams, ...queryParams, ...jsonBodyParams].map((p) => (
        <label key={`${p.in}-${p.name}`} className="flex items-center gap-2 text-xs">
          <span className="w-28 shrink-0 font-mono text-muted-foreground">
            {p.name} <span className="text-muted-foreground/60">({p.in})</span>
          </span>
          <input
            type="text"
            value={values[p.name] ?? ""}
            placeholder={p.example ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      ))}
      {fileBodyParam && (
        <label className="flex items-center gap-2 text-xs">
          <span className="w-28 shrink-0 font-mono text-muted-foreground">
            file <span className="text-muted-foreground/60">(body)</span>
          </span>
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-xs file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-xs file:font-medium"
          />
        </label>
      )}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={run} disabled={loading}>
          {loading ? "Running…" : "Try it"}
        </Button>
        <code className="truncate font-mono text-[11px] text-muted-foreground">
          {ep.method} {buildUrl()}
        </code>
      </div>
      {resp && (
        <div className="mt-2 rounded-md border bg-muted/40 p-2">
          <div className="mb-1 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
            <span>HTTP {resp.status}</span>
            {resp.mime && <span>{resp.mime}</span>}
            <span>{resp.body.length.toLocaleString()} chars</span>
          </div>
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
            {resp.body || "(empty)"}
          </pre>
        </div>
      )}
    </div>
  );
}

// ─── curl snippet for everything not safely try-it-able ───────────────────

function CurlSnippet({ ep }: { ep: ApiEndpoint }) {
  const isModal = ep.section === "modal";
  const isReviewGen = ep.section === "review-gen";
  const base = isModal
    ? "$YOUR_MODAL_URL"
    : isReviewGen
    ? "http://localhost:8001"
    : "http://localhost:8000";

  // Build a representative body when there are body params.
  const bodyParams = (ep.params ?? []).filter((p) => p.in === "body");
  const body =
    bodyParams.length > 0
      ? "\\\n  -d " +
        JSON.stringify(
          Object.fromEntries(
            bodyParams.map((p) => [p.name, p.example ?? `<${p.name}>`]),
          ),
        )
      : "";
  const auth = ep.section === "node-admin" ? '\\\n  -H "Authorization: Bearer $ADMIN_TOKEN"' : "";
  const modalAuth = isModal ? '\\\n  -H "X-Modal-Auth: $MODAL_SHARED_SECRET"' : "";

  const cmd = `curl -sS -X ${ep.method} "${base}${ep.path}" \\
  -H "content-type: application/json"${auth}${modalAuth}${body}`;

  const copy = () => navigator.clipboard.writeText(cmd).catch(() => {});

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">
          {ep.safe ? "Reference command" : "Mutating — copy + adapt before running"}
        </span>
        <Button size="sm" variant="outline" onClick={copy}>
          Copy
        </Button>
      </div>
      <pre className="overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs">
        {cmd}
      </pre>
    </div>
  );
}
