import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ReviewSkeleton } from "@/components/comparison/ReviewSkeleton";

/**
 * The pre-streaming state: shown while we wait for /pair to land the
 * chosen reviewIds. Surfaces a "warming up" hint once 30 s have passed
 * so users know cold-start is normal, not a hang. Marker + Modal vLLM
 * can take 60-90 s on a fresh container.
 */
export function GeneratingPanel({
  completed,
  expected,
  parseFailed,
}: {
  completed: number;
  expected: number;
  parseFailed: boolean;
}) {
  const pct = expected > 0 ? Math.min(100, (completed / expected) * 100) : 0;

  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (parseFailed) return;
    const startedAt = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), 1000);
    return () => clearInterval(id);
  }, [parseFailed]);
  const showWarmupHint = elapsedMs > 30_000 && expected === 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6">
          {parseFailed ? (
            <div className="text-sm text-destructive">
              PDF parsing failed. Try a text-based PDF (not a scan).
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 text-sm">
                <div className="font-medium">Parsing paper &amp; selecting pair…</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {expected > 0
                    ? `pair of ${expected}`
                    : `${Math.floor(elapsedMs / 1000)}s`}
                </div>
              </div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all animate-pulse"
                  style={{ width: pct > 0 ? `${pct}%` : "20%" }}
                />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Two review systems are picked at random. Once the pair is
                ready, both reviews stream into the panels below
                token-by-token.
              </p>
              {showWarmupHint && (
                <p className="mt-2 text-xs text-amber-400">
                  First upload of the session — Marker is warming up its GPU
                  container. This typically takes 60-90 seconds, then later
                  uploads complete in 30-45s.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ReviewSkeleton label="Review A" />
        <ReviewSkeleton label="Review B" />
      </div>
    </div>
  );
}
