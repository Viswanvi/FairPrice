"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, Chip, ErrorNote, relevanceTone, WorkingLabel } from "../../../_components/ui";
import { callApi } from "./api";
import type { ProductView } from "./types";

const ANALYZE_MESSAGES = [
  "Reading your product and working out who buys it…",
  "Checking the language, topic and who it's useful for…",
  "Weighing each region of the world…",
  "Almost there…",
];

export function AudiencePanel({ product, onContinue }: { product: ProductView; onContinue: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const profile = product.audienceProfile;

  async function analyze() {
    setBusy(true);
    setError(null);
    const res = await callApi<{ notes?: string[] }>(`/api/products/${product.id}/analyze`, "POST");
    setBusy(false);
    if (!res.ok) {
      setError(res.data.message ?? "The analysis didn't finish. Please try again.");
      return;
    }
    setNotes(res.data.notes ?? []);
    router.refresh();
  }

  return (
    <Card className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Who buys this product</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            The AI reads your {product.sourceUrl ? "product page" : "description"} and rates how relevant it is in each
            region. Prices follow from this: deep discounts where real buyers are, little or none where they aren&apos;t.
          </p>
        </div>
        {profile && !busy && (
          <Button variant="secondary" onClick={analyze}>
            Run again
          </Button>
        )}
      </div>

      {busy && <WorkingLabel messages={ANALYZE_MESSAGES} />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {notes.map((n) => (
        <p key={n} className="rounded-lg bg-warn-soft px-4 py-2 text-sm text-warn">
          {n}
        </p>
      ))}

      {!profile && !busy && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-line-strong p-6">
          <p className="text-sm text-ink-2">No analysis yet. It takes about 10–20 seconds.</p>
          <Button onClick={analyze}>Analyze audience</Button>
        </div>
      )}

      {profile && (
        <>
          <div className="flex flex-wrap gap-2">
            <Chip tone="accent">{profile.category}</Chip>
            <Chip>{profile.language}</Chip>
            <Chip>{profile.buyerType === "individual" ? "Individual buyers" : "Business buyers"}</Chip>
            <Chip tone={profile.shareability === "high" ? "warn" : "neutral"}>
              {profile.shareability === "high" ? "Easy to share" : profile.shareability === "medium" ? "Some sharing risk" : "Hard to share"}
            </Chip>
          </div>
          <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {profile.regions.map((r) => (
              <li key={r.region} className="flex items-start gap-3 border-b border-line py-2.5 last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0">
                <span className="w-20 shrink-0 pt-0.5">
                  <Chip tone={relevanceTone(r.relevance)}>{r.relevance}</Chip>
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{r.region}</span>
                  <span className="block text-sm text-ink-2">{r.reason}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <Button onClick={onContinue}>Continue to prices</Button>
          </div>
        </>
      )}
    </Card>
  );
}
