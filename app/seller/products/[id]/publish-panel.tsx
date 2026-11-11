"use client";

import { Button, Card, Chip, CopyButton } from "../../../_components/ui";
import { embedSnippet, formatDateTimeUtc, shortHash } from "@/lib/seller/format";
import type { LiveView, ProductView, TableView } from "./types";

export function PublishPanel({
  product,
  live,
  latest,
  pageUrl,
  onBackToPrices,
}: {
  product: ProductView;
  live: LiveView | null;
  latest: TableView | null;
  pageUrl: string;
  onBackToPrices: () => void;
}) {
  if (!live) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <h2 className="text-lg font-semibold">Publish</h2>
        <p className="text-sm text-ink-2">Approve a price table first. Buyers only ever see an approved version.</p>
        <Button variant="secondary" onClick={onBackToPrices}>
          Back to prices
        </Button>
      </Card>
    );
  }

  const snippet = embedSnippet(pageUrl, product.title);
  const newerDraft = latest && latest.status === "draft" && latest.version > live.version ? latest : null;

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Your product page is live</h2>
          <Chip tone="ok">Version {live.version}</Chip>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Hosted page</span>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-sm">
              {pageUrl}
            </code>
            <CopyButton text={pageUrl} />
            <a
              href={pageUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center rounded-lg border border-line-strong px-3 text-sm font-medium hover:bg-surface-2"
            >
              Open
            </a>
          </div>
          <p className="text-sm text-ink-3">Each visitor sees the price for their country. PayPal confirms the country before any money is captured.</p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Embed on your site</span>
          <div className="flex flex-wrap items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs leading-relaxed">
              {snippet}
            </code>
            <CopyButton text={snippet} />
          </div>
        </div>

        <dl className="grid gap-3 rounded-lg bg-surface-2 p-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-ink-3">Approved version</dt>
            <dd className="font-medium">v{live.version}</dd>
          </div>
          <div>
            <dt className="text-ink-3">Fingerprint</dt>
            <dd className="font-mono font-medium" title={live.contentHash}>
              {shortHash(live.contentHash)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">Approved</dt>
            <dd className="font-medium">{live.approvedAt ? formatDateTimeUtc(live.approvedAt) : "—"}</dd>
          </div>
        </dl>
        <p className="text-sm text-ink-3">
          Every order records this version and fingerprint, so you can always see which prices it was charged from.
        </p>
      </Card>

      {newerDraft && (
        <p className="rounded-lg bg-warn-soft px-4 py-3 text-sm text-warn">
          Draft version {newerDraft.version} isn&apos;t live yet. Buyers keep seeing version {live.version} until you approve it.
        </p>
      )}
    </div>
  );
}
