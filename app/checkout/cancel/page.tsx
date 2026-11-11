import type { Metadata } from "next";

export const metadata: Metadata = { title: "Payment cancelled · FairPrice" };

/** Where PayPal sends the buyer after cancelling in a full-page redirect. */
export default function CheckoutCancel() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center gap-3 px-6 py-16 text-center">
      <h1 className="text-xl font-semibold">Payment cancelled</h1>
      <p className="text-sm text-ink-2">You have not been charged. You can close this tab and try again whenever you like.</p>
    </main>
  );
}
