import type { Metadata } from "next";
import { CheckoutFlow } from "../checkout-flow";

export const metadata: Metadata = { title: "Checkout · FairPrice" };

/**
 * Where PayPal returns the buyer after a full-page redirect (PayPal's "auto" mode can choose this
 * on some phones). PayPal appends ?token=<orderId>; we finish the checkout here with the same
 * idempotent finalize call the popup flow uses, and show the same result screen.
 */
export default async function CheckoutReturn({ searchParams }: PageProps<"/checkout/return">) {
  const { token } = await searchParams;
  const orderId = typeof token === "string" && /^[A-Z0-9]{5,40}$/.test(token) ? token : null;

  return (
    <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col justify-center gap-4 px-4 py-10">
      {orderId ? (
        <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-5 shadow-card">
          <h1 className="text-lg font-semibold">Your payment</h1>
          <CheckoutFlow productId={null} as={null} resumeOrderId={orderId} />
        </section>
      ) : (
        <section className="flex flex-col gap-2 text-center">
          <h1 className="text-xl font-semibold">Approved in PayPal</h1>
          <p className="text-sm text-ink-2">
            You can close this tab and return to the page you came from to see the result. You won&apos;t be charged more
            than the price you approved.
          </p>
        </section>
      )}
    </main>
  );
}
