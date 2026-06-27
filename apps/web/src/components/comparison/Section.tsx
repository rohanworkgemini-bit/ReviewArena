import { type ReactNode } from "react";

/** Small titled section inside a review card. Used by ReviewPanel. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="font-semibold mb-1">{title}</div>
      {children}
    </div>
  );
}
