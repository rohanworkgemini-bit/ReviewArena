import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Section } from "@/components/comparison/Section";
import type { StructuredReview } from "@reviewarena/shared-types";

/** Renders a COMPLETED review with structured fields. */
export function ReviewPanel({
  label,
  review,
}: {
  label: string;
  review: StructuredReview;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{label}</CardTitle>
        <CardDescription>System identity is hidden until you vote.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <Section title="Summary">{review.summary}</Section>
        <Section title="Strengths">
          <ul className="list-disc pl-5 space-y-1">
            {review.strengths.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </Section>
        <Section title="Weaknesses">
          <ul className="list-disc pl-5 space-y-1">
            {review.weaknesses.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </Section>
        <Section title="Questions">
          <ul className="list-disc pl-5 space-y-1">
            {review.questions.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </Section>
        {review.overallRating !== undefined && (
          <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs font-mono">
            Overall {review.overallRating}/10
            {review.confidence !== undefined && `  ·  confidence ${review.confidence}/5`}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
