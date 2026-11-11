import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { demoBannerText, priceHeadline } from "@/lib/checkout/display";
import { buildQuote } from "@/lib/checkout/quote";
import { prisma } from "@/lib/db/client";
import { getApprovedTable } from "@/lib/db/price-tables";
import { env } from "@/lib/env";
import { displayCountry } from "@/lib/geo/country";
import { formatUsd } from "@/lib/seller/format";
import { CheckoutFlow } from "../../checkout/checkout-flow";

/**
 * Buyer product page (SPEC screen 7). Server-rendered: the price shown comes from the APPROVED
 * table for the visitor's display country (IP, or ?as= in demo mode). The browser never sends an
 * amount — checkout re-resolves everything on the server.
 */

async function load(productId: string) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  return product ? { product, table: await getApprovedTable(product.id) } : null;
}

export async function generateMetadata({ params }: PageProps<"/p/[productId]">): Promise<Metadata> {
  const { productId } = await params;
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { title: true } });
  return { title: product ? `${product.title} · FairPrice` : "FairPrice" };
}

export default async function BuyerPage({ params, searchParams }: PageProps<"/p/[productId]">) {
  const { productId } = await params;
  const as = (await searchParams).as;
  const loaded = await load(productId);
  if (!loaded) notFound();
  const { product, table } = loaded;

  if (!table) {
    return (
      <Shell>
        <section className="rounded-2xl border border-line bg-surface p-6 text-center shadow-card">
          <h1 className="text-xl font-semibold">{product.title}</h1>
          <p className="mt-2 text-sm text-ink-2">This product isn&apos;t on sale yet. Please check back soon.</p>
        </section>
      </Shell>
    );
  }

  const geo = await displayCountry({
    headers: await headers(),
    as: typeof as === "string" ? as : null,
    overrideEnabled: env.DEMO_GEO_OVERRIDE,
  });
  const quote = buildQuote(product, table, geo);
  const headline = priceHeadline(quote);
  const description = product.description?.trim();

  return (
    <Shell banner={quote.overridden && quote.shownCountry ? demoBannerText(quote.shownCountry) : null}>
      <section className="flex flex-col gap-5 rounded-2xl border border-line bg-surface p-5 shadow-card sm:p-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold leading-snug tracking-tight sm:text-2xl">{product.title}</h1>
          {description && <p className="line-clamp-4 text-sm leading-relaxed text-ink-2">{description}</p>}
        </div>

        <div className="flex flex-col gap-1 rounded-xl bg-surface-2 p-4">
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-semibold tracking-tight tabular-nums text-ink">{formatUsd(quote.priceCents)}</span>
            {headline.showStandard && (
              <span className="text-sm text-ink-3">
                Standard price <span className="line-through">{formatUsd(quote.standardCents)}</span>
              </span>
            )}
          </div>
          <p className="text-sm font-medium text-accent-strong">{headline.label}</p>
          {quote.requirePaypal && quote.inTable && quote.priceCents < quote.standardCents && (
            <p className="text-xs text-ink-3">Fair prices need a PayPal account; card payments pay the standard price.</p>
          )}
        </div>

        <CheckoutFlow productId={product.id} as={quote.overridden ? quote.shownCountry : null} />

        <p className="text-xs leading-relaxed text-ink-3">
          You approve the price in PayPal. Before any money is taken, PayPal confirms your account&apos;s country; if a
          different price applies there, you&apos;re never charged more than you approved.
        </p>
      </section>
    </Shell>
  );
}

function Shell({ children, banner = null }: { children: React.ReactNode; banner?: string | null }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      {banner && (
        <div role="status" className="bg-warn-soft px-4 py-2 text-center text-xs font-medium text-warn">
          {banner}
        </div>
      )}
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col gap-4 px-4 py-6 sm:py-10">{children}</main>
      <footer className="pb-6 text-center text-xs text-ink-3">
        Sold with FairPrice · PayPal sandbox demo
      </footer>
    </div>
  );
}
