import Link from "next/link";
import type { ReactNode } from "react";
import { currentSellerId } from "@/lib/auth/session";
import { SignOutButton } from "./sign-out-button";

export default async function SellerLayout({ children }: { children: ReactNode }) {
  const signedIn = Boolean(await currentSellerId());
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/seller" className="flex items-center gap-2 font-semibold tracking-tight text-ink">
            <span aria-hidden className="grid size-7 place-items-center rounded-md bg-accent text-sm font-bold text-accent-ink">
              F
            </span>
            FairPrice
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-medium text-ink-2">Seller</span>
          </Link>
          {signedIn && <SignOutButton />}
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
      <footer className="border-t border-line py-4 text-center text-xs text-ink-3">
        PayPal sandbox demo · prices are examples from approved tables
      </footer>
    </div>
  );
}
