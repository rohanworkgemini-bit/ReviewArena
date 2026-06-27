import { useCallback, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { useMutation, useQuery } from "@tanstack/react-query";
import { UploadCloud, FileText, Loader2, Link2, Sparkles } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

// Run a paper through a single chosen review system, end-to-end:
// upload PDF or paste arXiv link → pick a system → see the rendered
// review. Hits POST /api/reviews/playground which orchestrates parse +
// generate without touching the papers/reviews tables.

const MAX_SIZE = 10 * 1024 * 1024;
const ARXIV_HINT_RE =
  /^(?:https?:\/\/arxiv\.org\/(?:abs|pdf|html)\/)?\d{4}\.\d{4,5}(?:v\d+)?$/i;

type Source = "pdf" | "arxiv";

interface ReviewSystemListed {
  slug: string;
  name: string;
  description: string | null;
}

interface PlaygroundResponse {
  system: { slug: string; name: string; adapterKey: string };
  paper: { title: string | null; pageCount: number | null; source: string; canonicalTokens: number | null };
  // The canonical user-message bytes fed to the model (identical across systems).
  canonicalText: string | null;
  review: {
    summary: string;
    strengths: string[];
    weaknesses: string[];
    questions: string[];
    soundness: number | null;
    presentation: number | null;
    contribution: number | null;
    overallRating: number | null;
    confidence: number | null;
  };
  rawOutput: string;
  generationMs: number;
  metrics: { input_tokens?: number; output_tokens?: number; context_window?: number } | null;
}

export function ReviewerPlayground() {
  const [source, setSource] = useState<Source>("pdf");
  const [file, setFile] = useState<File | null>(null);
  const [arxivUrl, setArxivUrl] = useState("");
  const [systemSlug, setSystemSlug] = useState<string>("");
  const [dropError, setDropError] = useState<string | null>(null);

  const systemsQuery = useQuery<ReviewSystemListed[]>({
    queryKey: ["playground-review-systems"],
    queryFn: async () => {
      const r = await fetch("/api/review-systems", { credentials: "include" });
      if (!r.ok) throw new Error(`/review-systems ${r.status}`);
      const data = (await r.json()) as { systems: ReviewSystemListed[] };
      return data.systems;
    },
    staleTime: 5 * 60 * 1000,
  });

  const onDrop = useCallback((accepted: File[], rejected: FileRejection[]) => {
    setDropError(null);
    const r = rejected[0];
    if (r) {
      setDropError(
        r.errors.some((e) => e.code === "file-too-large")
          ? "File exceeds 10 MB."
          : "Only PDFs are accepted.",
      );
      return;
    }
    if (accepted[0]) setFile(accepted[0]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    maxSize: MAX_SIZE,
    multiple: false,
  });

  const mutation = useMutation<PlaygroundResponse, Error>({
    mutationFn: async () => {
      const fd = new FormData();
      fd.append("systemSlug", systemSlug);
      if (source === "pdf") {
        if (!file) throw new Error("Pick a PDF first");
        fd.append("file", file);
      } else {
        fd.append("url", arxivUrl.trim());
      }
      const r = await fetch("/api/reviews/playground", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(
          (err as { message?: string }).message ?? `playground ${r.status}`,
        );
      }
      return r.json();
    },
  });

  const arxivLooksValid = ARXIV_HINT_RE.test(arxivUrl.trim());
  const canSubmit =
    !mutation.isPending &&
    !!systemSlug &&
    (source === "pdf" ? !!file : arxivLooksValid);

  const selectedSystem = systemsQuery.data?.find((s) => s.slug === systemSlug);

  return (
    <Card className="border-primary/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          Reviewer Playground
        </CardTitle>
        <CardDescription>
          Upload a PDF or paste an arXiv link, pick one of the enabled
          reviewing systems, and see the review it produces. Calls{" "}
          <code className="font-mono text-xs">POST /api/reviews/playground</code>{" "}
          — doesn't touch the papers/reviews tables.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Source tabs */}
        <div className="inline-flex rounded-md border bg-card p-1">
          {(["pdf", "arxiv"] as const).map((t) => {
            const active = source === t;
            const Icon = t === "pdf" ? UploadCloud : Link2;
            return (
              <button
                key={t}
                type="button"
                onClick={() => setSource(t)}
                className={cn(
                  "flex items-center gap-2 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {t === "pdf" ? "Upload PDF" : "arXiv link"}
              </button>
            );
          })}
        </div>

        {/* Input */}
        {source === "pdf" ? (
          <div
            {...getRootProps()}
            className={cn(
              "flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-input p-8 text-center cursor-pointer transition-colors",
              isDragActive && "border-primary bg-accent/50",
              file && "border-primary/50 bg-accent/20",
            )}
          >
            <input {...getInputProps()} />
            {file ? (
              <div className="flex items-center gap-3 text-sm">
                <FileText className="h-8 w-8 text-muted-foreground" />
                <div className="text-left">
                  <div className="font-medium">{file.name}</div>
                  <div className="text-muted-foreground">
                    {(file.size / 1024 / 1024).toFixed(2)} MB — click to replace
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground">
                <UploadCloud className="h-8 w-8" />
                <div className="text-sm">
                  {isDragActive ? "Release to upload" : "Drag a PDF here, or click to browse"}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            <input
              value={arxivUrl}
              onChange={(e) => setArxivUrl(e.target.value)}
              placeholder="2312.00752  or  https://arxiv.org/abs/2312.00752"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-xs text-muted-foreground">
              Parsed via arxiv2md.org — works for arXiv papers with HTML rendering.
            </p>
          </div>
        )}
        {dropError && <Badge variant="destructive">{dropError}</Badge>}

        {/* System picker */}
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="playground-system">
            Review system
          </label>
          {systemsQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading systems…</div>
          ) : systemsQuery.isError ? (
            <div className="text-sm text-destructive">
              Failed to load: {(systemsQuery.error as Error).message}
            </div>
          ) : (
            <select
              id="playground-system"
              value={systemSlug}
              onChange={(e) => setSystemSlug(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">— Pick a system —</option>
              {(systemsQuery.data ?? []).map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.name} ({s.slug})
                </option>
              ))}
            </select>
          )}
          {selectedSystem?.description && (
            <p className="text-xs text-muted-foreground">{selectedSystem.description}</p>
          )}
        </div>

        {/* Submit */}
        <div className="flex items-center justify-between gap-4 pt-2">
          <div className="text-xs text-muted-foreground">
            {mutation.isPending
              ? "Working… (parse 5-30s + generation 5-90s)"
              : "Submission flows through full canonical-input + 3,072 token cap."}
          </div>
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit}>
            {mutation.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Running review…
              </>
            ) : (
              "Run review"
            )}
          </Button>
        </div>

        {mutation.isError && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {(mutation.error as Error).message}
          </div>
        )}

        {mutation.data && <PlaygroundResult data={mutation.data} />}
      </CardContent>
    </Card>
  );
}

function PlaygroundResult({ data }: { data: PlaygroundResponse }) {
  const r = data.review;
  const renderScore = (v: number | null, max: number) =>
    v == null ? "—" : `${v.toFixed(1)}/${max}`;
  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="flex flex-wrap items-baseline gap-3 text-sm">
        <span className="font-medium">{data.paper.title ?? "(untitled)"}</span>
        <span className="text-xs text-muted-foreground">
          {data.paper.source} · {data.paper.canonicalTokens ?? "?"} tokens in
        </span>
        <Badge variant="secondary">{data.system.name}</Badge>
        <span className="text-xs text-muted-foreground">
          {(data.generationMs / 1000).toFixed(1)}s · {data.metrics?.output_tokens ?? "?"} tokens out
        </span>
      </div>

      <ScoreGrid r={r} renderScore={renderScore} />

      <Section title="Summary" text={r.summary} />
      {r.strengths.length > 0 && <BulletSection title="Strengths" items={r.strengths} />}
      {r.weaknesses.length > 0 && <BulletSection title="Weaknesses" items={r.weaknesses} />}
      {r.questions.length > 0 && <BulletSection title="Questions" items={r.questions} />}

      {data.canonicalText && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Raw model input — user message ({data.canonicalText.length.toLocaleString()} chars,{" "}
            {data.paper.canonicalTokens?.toLocaleString() ?? "?"} cl100k tokens)
          </summary>
          <p className="mt-2 text-[11px] text-muted-foreground">
            This is the exact user-message content fed to <code>{data.system.adapterKey}</code>.
            The system prompt (instructions for the reviewer role) is adapter-specific and
            is not shown here — see <code>services/review-gen/app/adapters/{data.system.adapterKey}.py</code>.
          </p>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-background p-3 font-mono text-xs">
            {data.canonicalText}
          </pre>
        </details>
      )}

      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          Raw model output ({data.rawOutput.length.toLocaleString()} chars)
        </summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-background p-3 font-mono text-xs">
          {data.rawOutput}
        </pre>
      </details>
    </div>
  );
}

function ScoreGrid({
  r,
  renderScore,
}: {
  r: PlaygroundResponse["review"];
  renderScore: (v: number | null, max: number) => string;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5 text-xs">
      <ScoreCell label="Soundness" value={renderScore(r.soundness, 10)} />
      <ScoreCell label="Presentation" value={renderScore(r.presentation, 10)} />
      <ScoreCell label="Contribution" value={renderScore(r.contribution, 10)} />
      <ScoreCell label="Rating" value={renderScore(r.overallRating, 10)} />
      <ScoreCell label="Confidence" value={renderScore(r.confidence, 5)} />
    </div>
  );
}

function ScoreCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border bg-background px-2 py-1.5 text-center">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono tabular-nums">{value}</div>
    </div>
  );
}

function Section({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      <p className="mt-1 whitespace-pre-wrap text-sm">{text}</p>
    </div>
  );
}

function BulletSection({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      <ul className="mt-1 list-disc pl-5 text-sm space-y-0.5">
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
