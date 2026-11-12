"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FILL_PRODUCT_FORM_EVENT } from "../../../_components/assistant/events";
import { Button, Card, ErrorNote, Field, inputClass, Segmented, Switch } from "../../../_components/ui";
import type { ProductFormFields } from "@/lib/assistant/schema";
import { formatUsd, parseDollarsToCents } from "@/lib/seller/format";

const amount = (usd: number) => String(Math.round(usd * 100) / 100);

type Goal = "revenue" | "reach";

export function ProductForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [description, setDescription] = useState("");
  const [base, setBase] = useState("99");
  const [min, setMin] = useState("15");
  const [maxDiscount, setMaxDiscount] = useState("70");
  const [goal, setGoal] = useState<Goal>("reach");
  const [requirePaypal, setRequirePaypal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The voice assistant fills in what the seller told it; the seller still checks and continues.
  useEffect(() => {
    const fill = (event: Event) => {
      const f = (event as CustomEvent<ProductFormFields>).detail;
      if (f.title !== undefined) setTitle(f.title);
      if (f.description !== undefined) setDescription(f.description);
      if (f.baseUsd !== undefined) setBase(amount(f.baseUsd));
      if (f.minUsd !== undefined) setMin(amount(f.minUsd));
      if (f.maxDiscountPct !== undefined) setMaxDiscount(String(f.maxDiscountPct));
      if (f.goal !== undefined) setGoal(f.goal);
    };
    window.addEventListener(FILL_PRODUCT_FORM_EVENT, fill);
    return () => window.removeEventListener(FILL_PRODUCT_FORM_EVENT, fill);
  }, []);

  const baseCents = parseDollarsToCents(base);
  const minCents = parseDollarsToCents(min);
  const maxDiscountPct = /^\d{1,2}$/.test(maxDiscount.trim()) ? Number(maxDiscount) : null;
  const errors = {
    base: baseCents === null ? "Enter an amount like 99 or 34.99." : baseCents < 100 ? "At least $1." : undefined,
    min:
      minCents === null
        ? "Enter an amount like 15."
        : baseCents !== null && minCents > baseCents
          ? "Can't be above the base price."
          : undefined,
    maxDiscount: maxDiscountPct === null || maxDiscountPct > 95 ? "A whole number from 0 to 95." : undefined,
    source: !sourceUrl.trim() && !description.trim() ? "Add a product link or a description." : undefined,
  };
  const valid = title.trim() && !errors.base && !errors.min && !errors.maxDiscount && !errors.source;
  const lowest =
    baseCents !== null && maxDiscountPct !== null && minCents !== null
      ? Math.max(minCents, Math.ceil((baseCents * (100 - maxDiscountPct)) / 100))
      : null;

  return (
    <form
      data-assistant-form="product"
      className="flex flex-col gap-5"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        setError(null);
        try {
          const res = await fetch("/api/products", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: title.trim(),
              sourceUrl: sourceUrl.trim() || null,
              description: description.trim() || null,
              baseCents,
              minCents,
              maxDiscountPct,
              goal,
              requirePaypal,
            }),
          });
          const body = (await res.json().catch(() => null)) as { productId?: string; message?: string } | null;
          if (!res.ok || !body?.productId) {
            setError(body?.message ?? "We couldn't create the product. Please try again.");
            return;
          }
          router.push(`/seller/products/${body.productId}`);
        } catch {
          setError("We couldn't reach the server. Check your connection and try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <Card className="flex flex-col gap-5">
        <h2 className="text-base font-semibold">What you sell</h2>
        <Field label="Product name" htmlFor="title">
          <input id="title" required value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} placeholder="Full-Stack JavaScript Bootcamp" />
        </Field>
        <Field label="Product page link" htmlFor="sourceUrl" hint="We read the page to understand who buys it." error={sourceUrl || description ? undefined : errors.source}>
          <input id="sourceUrl" type="url" inputMode="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} className={inputClass} placeholder="https://…" />
        </Field>
        <Field label="Or describe it" htmlFor="description" hint="Topic, language, who it's for. A few sentences is enough.">
          <textarea
            id="description"
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={`${inputClass} h-auto py-2 leading-relaxed`}
          />
        </Field>
      </Card>

      <Card className="flex flex-col gap-5">
        <h2 className="text-base font-semibold">Your limits</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Base price (USD)" htmlFor="base" error={errors.base}>
            <input id="base" inputMode="decimal" value={base} onChange={(e) => setBase(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Minimum price (USD)" htmlFor="min" error={errors.min}>
            <input id="min" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Maximum discount (%)" htmlFor="maxDiscount" error={errors.maxDiscount}>
            <input id="maxDiscount" inputMode="numeric" value={maxDiscount} onChange={(e) => setMaxDiscount(e.target.value)} className={inputClass} />
          </Field>
        </div>
        {lowest !== null && !errors.base && !errors.min && !errors.maxDiscount && (
          <p className="text-sm text-ink-3">No country will pay less than {formatUsd(lowest)}.</p>
        )}
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Goal</span>
          <Segmented<Goal>
            label="Goal"
            value={goal}
            onChange={setGoal}
            options={[
              { value: "revenue", label: "Maximize revenue" },
              { value: "reach", label: "Maximize reach" },
            ]}
          />
          <p className="text-sm text-ink-3">
            {goal === "reach" ? "Deeper discounts where real buyers are." : "Shallower discounts that protect your margin."}
          </p>
        </div>
        <Switch
          id="requirePaypal"
          checked={requirePaypal}
          onChange={setRequirePaypal}
          label="Require PayPal for fair prices"
          description="Buyers who pay by card without a PayPal account get the standard price, because their country can't be confirmed."
        />
      </Card>

      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex justify-end">
        <Button type="submit" loading={busy} disabled={!valid} data-assistant="continue_setup">
          Continue
        </Button>
      </div>
    </form>
  );
}
