import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { ReviewStreamState } from "@/hooks/useReviewStream";

/**
 * Renders an in-flight review as live-streaming markdown. Shows a
 * blinking caret while tokens still arrive; surfaces stream errors
 * with a retry button so a transient Modal cold-start hiccup doesn't
 * trap the user.
 */
export function LiveStreamingPanel({
  label,
  stream,
}: {
  label: string;
  stream: ReviewStreamState;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{label}</CardTitle>
        <CardDescription>
          {stream.error
            ? "Generation failed."
            : stream.text
            ? "Generating live…"
            : "Waiting for first token…"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {stream.error ? (
          <div className="space-y-3">
            <p className="text-destructive">{stream.error}</p>
            <Button type="button" size="sm" variant="outline" onClick={stream.retry}>
              Retry
            </Button>
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
            {stream.text}
            {!stream.done && (
              <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-foreground/60 align-middle" />
            )}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}
