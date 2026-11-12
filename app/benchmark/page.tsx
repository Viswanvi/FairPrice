import type { Metadata } from "next";
import Link from "next/link";
import type { BenchmarkProduct } from "@/lib/pricing/benchmark";
import { loadBenchmark } from "@/lib/pricing/benchmark-data";
import { countryName, formatDateTimeUtc, formatUsd } from "@/lib/seller/format";
import { cx } from "../_components/cx";
import { BenchmarkGrid } from "./benchmark-grid";

export const metadata: Metadata = {
  title: "Formula vs AI · FairPrice",
  description: "Five invented products priced for 42 countries by a purchasing-power formula and by FairPrice's AI.",
};

/**
 * Formula-versus-AI benchmark (SPEC section 7, the demo's "innovation moment"). Reads the
 * precomputed data/benchmark-results.json so it loads instantly. Descriptive only — the products
 * are invented and there is no sales data, so no conversion or revenue claims.
 */

const label = (kind: string) => kind.charAt(0).toUpperCase() + kind.slice(1);
const RELEVANCE_TONE = { high: "bg-accent-soft text-accent-strong", medium: "bg-surface-2 text-ink-2", low: "border border-dashed border-line-strong text-ink-3" };

export default async function BenchmarkPage({ searchParams }: PageProps<"/benchmark">) {
  const data = loadBenchmark();
  if (!data) {
    return (
      <Page>
        <p className="rounded-xl border border-dashed border-line-strong p-8 text-center text-sm text-ink-2">
          The benchmark hasn&apos;t been generated yet. Run <code className="font-mono">npm run benchmark</code>.
        </p>
      </Page>
    );
  }
  const requested = (await searchParams).product;
  const product = data.products.find((p) => p.id === requested) ?? data.products[0];
  const lowCount = product.averageDiscountByRelevance.low.countries;

  return (
    <Page>
      <nav aria-label="Products" className="flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1 [scrollbar-width:none]">
        {data.products.map((p) => (
          <Link
            key={p.id}
            href={`/benchmark?product=${p.id}`}
            aria-current={p.id === product.id ? "page" : undefined}
            className={cx(
              "flex h-9 shrink-0 items-center rounded-lg px-3 text-sm font-medium transition-colors",
              p.id === product.id ? "bg-accent-soft text-accent-strong" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            {label(p.kind)}
          </Link>
        ))}
      </nav>

      <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">{product.title}</h2>
          <span className="text-sm text-ink-2">
            Base {formatUsd(product.baseCents)} · minimum {formatUsd(product.minCents)} · up to {product.maxDiscountPct}% off ·{" "}
            {product.goal === "reach" ? "maximize reach" : "maximize revenue"}
          </span>
        </div>
        <p className="text-sm text-ink-2">{product.productSummary}</p>
        <div className="flex flex-wrap gap-1.5">
          {product.audience.regions.map((r) => (
            <span key={r.region} title={r.reason} className={cx("rounded-full px-2.5 py-0.5 text-xs font-medium", RELEVANCE_TONE[r.relevance])}>
              {r.region} · {r.relevance}
            </span>
          ))}
        </div>
      </section>

      <Legend />
      <div className="grid gap-4 lg:grid-cols-3">
        <StatTile
          marker="benchmark_tile"
          title="More than 20% off where the audience is small"
          formula={product.counts.deepDiscountLowRelevance.formula}
          ai={product.counts.deepDiscountLowRelevance.ai}
          note={`Out of ${lowCount} ${lowCount === 1 ? "country" : "countries"} the AI rated low relevance for this product.`}
        />
        <StatTile
          title={`Priced below the ${formatUsd(data.feeFloorCents)} payment-fee floor`}
          formula={product.counts.belowFeeFloor.formula}
          ai={product.counts.belowFeeFloor.ai}
          note="Both stay above it: the seller's minimum price is already higher than the fee floor."
        />
        <RelevanceBars product={product} />
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Where they differ most</h2>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {product.biggestDifferences.map((code) => {
            const r = product.rows.find((x) => x.country === code)!;
            const diff = r.aiPriceCents - r.formulaPriceCents;
            return (
              <li key={code} className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4 shadow-card">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{countryName(code)}</span>
                  <span className={cx("rounded-full px-2 py-0.5 text-xs font-medium", RELEVANCE_TONE[r.relevance])}>{r.relevance}</span>
                </div>
                <p className="text-sm tabular-nums text-ink-2">
                  Formula <span className="font-medium text-ink">{formatUsd(r.formulaPriceCents)}</span> → AI{" "}
                  <span className="font-semibold text-ink">{formatUsd(r.aiPriceCents)}</span>{" "}
                  <span className="text-ink-3">
                    ({diff > 0 ? "+" : "−"}
                    {formatUsd(Math.abs(diff))})
                  </span>
                </p>
                <p className="text-sm leading-snug text-ink">{r.reason}</p>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">All 42 countries</h2>
        <BenchmarkGrid
          top={product.biggestDifferences}
          rows={product.rows.map((r) => ({
            country: r.country,
            region: r.region,
            relevance: r.relevance,
            priceCents: r.aiPriceCents,
            discountPct: r.aiDiscountPct,
            formulaPriceCents: r.formulaPriceCents,
            reason: r.reason,
            flags: r.flags,
          }))}
        />
      </section>

      <p className="text-xs leading-relaxed text-ink-3">
        {data.note} Generated {formatDateTimeUtc(data.generatedAt)} with {data.model} (prompts {data.promptVersion}). AI prices are
        proposals that passed the same validator a seller&apos;s table must pass.
      </p>
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight text-ink">
            <span aria-hidden className="grid size-7 place-items-center rounded-md bg-accent text-sm font-bold text-accent-ink">
              F
            </span>
            FairPrice
          </Link>
          <Link href="/seller" className="text-sm text-ink-2 hover:text-ink">
            Seller app
          </Link>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Formula vs AI</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-2">
            Five invented products, priced for 42 countries two ways: a purchasing-power formula that treats every product the
            same, and FairPrice&apos;s AI, which prices by who actually buys the product. Both are checked by the same rules.
          </p>
        </div>
        {children}
      </main>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex items-center gap-4 text-sm text-ink-2" aria-label="Legend">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="size-3 rounded-sm bg-series-formula" /> Formula
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="size-3 rounded-sm bg-series-ai" /> AI
      </span>
    </div>
  );
}

function StatTile({ title, formula, ai, note, marker }: { title: string; formula: number; ai: number; note: string; marker?: string }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-card" data-assistant-highlight={marker}>
      <h3 className="text-sm font-medium text-ink-2">{title}</h3>
      <div className="flex items-end gap-6">
        <Figure label="Formula" value={formula} swatch="bg-series-formula" />
        <Figure label="AI" value={ai} swatch="bg-series-ai" />
      </div>
      <p className="text-xs text-ink-3">{note}</p>
    </section>
  );
}

function Figure({ label, value, swatch }: { label: string; value: number; swatch: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs text-ink-3">
        <span aria-hidden className={cx("size-2.5 rounded-sm", swatch)} />
        {label}
      </span>
      <span className="text-3xl font-semibold tabular-nums text-ink">{value}</span>
    </div>
  );
}

/** Average discount per relevance level, formula vs AI, as thin labelled bars (scale: 0 to the max discount). */
function RelevanceBars({ product }: { product: BenchmarkProduct }) {
  const scale = Math.max(product.maxDiscountPct, 1);
  const levels = (["high", "medium", "low"] as const).filter((l) => product.averageDiscountByRelevance[l].countries > 0);
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-card">
      <h3 className="text-sm font-medium text-ink-2">Average discount by audience relevance</h3>
      <div className="flex flex-col gap-3">
        {levels.map((level) => {
          const a = product.averageDiscountByRelevance[level];
          return (
            <div key={level} className="flex flex-col gap-1">
              <span className="text-xs text-ink-2">
                <span className="font-medium capitalize text-ink">{level}</span> · {a.countries} {a.countries === 1 ? "country" : "countries"}
              </span>
              {(
                [
                  ["Formula", a.formula, "bg-series-formula"],
                  ["AI", a.ai, "bg-series-ai"],
                ] as const
              ).map(([name, value, color]) => (
                <div key={name} className="flex items-center gap-2" title={`${name}: ${value}% average discount for ${level}-relevance countries`}>
                  <div className="h-2 flex-1 rounded-full bg-surface-2">
                    <div className={cx("h-2 rounded-full", color)} style={{ width: `${Math.min(100, (value / scale) * 100)}%` }} />
                  </div>
                  <span className="w-28 shrink-0 whitespace-nowrap text-right text-xs tabular-nums text-ink-2">
                    {name} {value}%
                  </span>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
