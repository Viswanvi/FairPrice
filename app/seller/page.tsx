import type { Metadata } from "next";
import Link from "next/link";
import { Chip } from "../_components/ui";
import { requireSellerPage } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";
import { formatUsd } from "@/lib/seller/format";

export const metadata: Metadata = { title: "Products · FairPrice" };

const statusChip = {
  approved: { tone: "ok", label: "Approved" },
  draft: { tone: "warn", label: "Draft" },
  superseded: { tone: "neutral", label: "Superseded" },
} as const;

export default async function SellerHome() {
  const sellerId = await requireSellerPage();
  const products = await prisma.product.findMany({
    where: { sellerId },
    orderBy: { createdAt: "desc" },
    include: {
      priceTables: { orderBy: { version: "desc" }, take: 1, select: { version: true, status: true } },
      _count: { select: { orders: true } },
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your products</h1>
          <p className="mt-1 text-sm text-ink-2">Each product gets an AI-proposed fair price per country. Nothing goes live until you approve it.</p>
        </div>
        <Link
          href="/seller/products/new"
          className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink shadow-card hover:bg-accent-strong"
        >
          New product
        </Link>
      </div>

      {products.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line-strong p-10 text-center text-sm text-ink-2">
          No products yet. Create one to get fair prices for every country.
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {products.map((p) => {
            const latest = p.priceTables[0];
            const chip = latest ? statusChip[latest.status] : null;
            return (
              <li key={p.id}>
                <Link
                  href={`/seller/products/${p.id}`}
                  className="flex h-full flex-col gap-3 rounded-xl border border-line bg-surface p-5 shadow-card transition-colors hover:border-accent"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="font-medium leading-snug text-ink">{p.title}</h2>
                    {chip ? (
                      <Chip tone={chip.tone}>
                        v{latest.version} · {chip.label}
                      </Chip>
                    ) : (
                      <Chip tone="muted">No prices yet</Chip>
                    )}
                  </div>
                  <p className="text-sm text-ink-2">
                    Base {formatUsd(p.baseCents)} · minimum {formatUsd(p.minCents)} · up to {p.maxDiscountPct}% off ·{" "}
                    {p.goal === "reach" ? "maximize reach" : "maximize revenue"}
                  </p>
                  <p className="mt-auto text-sm text-ink-3">
                    {p._count.orders === 0 ? "No orders yet" : `${p._count.orders} order${p._count.orders === 1 ? "" : "s"}`}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
