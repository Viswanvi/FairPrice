export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">FairPrice</h1>
      <p className="text-lg leading-8 text-zinc-600 dark:text-zinc-400">
        A fair price for digital products in every country, with the buyer&apos;s
        country confirmed by PayPal before any money is captured.
      </p>
      <div className="flex flex-wrap gap-2">
        <a
          href="/seller"
          className="inline-flex h-10 items-center rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink hover:bg-accent-strong"
        >
          Open the seller app
        </a>
        <a
          href="/benchmark"
          className="inline-flex h-10 items-center rounded-lg border border-line-strong px-4 text-sm font-medium text-ink hover:bg-surface-2"
        >
          Formula vs AI benchmark
        </a>
      </div>
    </main>
  );
}
