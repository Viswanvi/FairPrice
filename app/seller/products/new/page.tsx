import type { Metadata } from "next";
import Link from "next/link";
import { requireSellerPage } from "@/lib/auth/session";
import { ProductForm } from "./product-form";

export const metadata: Metadata = { title: "New product · FairPrice" };

export default async function NewProductPage() {
  await requireSellerPage();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div>
        <Link href="/seller" className="text-sm text-ink-2 hover:text-ink">
          ← Products
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Set up a product</h1>
        <p className="mt-1 text-sm text-ink-2">
          Tell us what you sell and your limits. The AI works out who buys it, then proposes a price for each country.
        </p>
      </div>
      <ProductForm />
    </div>
  );
}
