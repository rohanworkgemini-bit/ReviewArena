import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Placeholder card while the model hasn't started streaming yet. */
export function ReviewSkeleton({ label }: { label: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{label}</CardTitle>
        <CardDescription>Waiting on the model…</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {[90, 75, 85, 60, 80, 70].map((w, i) => (
          <div
            key={i}
            className="h-3 rounded bg-muted animate-pulse"
            style={{ width: `${w}%` }}
          />
        ))}
      </CardContent>
    </Card>
  );
}
