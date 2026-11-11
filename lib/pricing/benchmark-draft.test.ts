import { describe, expect, it } from "vitest";
import benchmarkJson from "@/data/benchmark-results.json";
import { formulaRowsSchema, priceRowsSchema } from "@/lib/db/types";
import { benchmarkFileSchema, type BenchmarkProduct } from "./benchmark";
import { benchmarkDraft, BenchmarkDraftError } from "./benchmark-draft";
import { feeConfig, targetCountries } from "./data";
import { feeFloorCents } from "./formula";
import { checkStoredRows } from "./table-check";

const benchmark = benchmarkFileSchema.parse(benchmarkJson);
const byId = (id: string): BenchmarkProduct => structuredClone(benchmark.products.find((p) => p.id === id)!);

describe("benchmarkDraft — the committed benchmark products", () => {
  it.each(benchmark.products.map((p) => [p.id, p] as const))("%s rebuilds into a valid draft", (_id, product) => {
    const draft = benchmarkDraft(product);

    // Every target country, priced exactly as the committed AI table.
    expect(draft.rows.map((r) => r.country)).toEqual(targetCountries().map((t) => t.code));
    for (const row of draft.rows) {
      const committed = product.rows.find((r) => r.country === row.country)!;
      expect(row.priceCents).toBe(committed.aiPriceCents);
      expect(row.formulaPriceCents).toBe(committed.formulaPriceCents);
      expect(row.discountPct).toBe(committed.aiDiscountPct);
    }

    // Storable as-is, and approvable: the approval re-check finds nothing wrong.
    expect(priceRowsSchema.safeParse(draft.rows).success).toBe(true);
    expect(formulaRowsSchema.safeParse(draft.formulaRows).success).toBe(true);
    expect(checkStoredRows(draft.rows, product).errors).toEqual([]);
    expect(draft.audienceProfile.regions.length).toBeGreaterThan(0);
  });
});

describe("benchmarkDraft — refuses bad data instead of seeding it", () => {
  it("an AI price below the fee floor throws, naming the country", () => {
    const product = byId("bench-coding-course");
    const row = product.rows.find((r) => r.country === "IN")!;
    row.aiPriceCents = feeFloorCents(feeConfig()) - 1;
    expect(() => benchmarkDraft(product)).toThrow(BenchmarkDraftError);
    expect(() => benchmarkDraft(product)).toThrow(/IN/);
  });

  it("an AI price above the base price throws", () => {
    const product = byId("bench-ebook");
    product.rows[0].aiPriceCents = product.baseCents + 100;
    expect(() => benchmarkDraft(product)).toThrow(BenchmarkDraftError);
  });

  it("a missing country throws", () => {
    const product = byId("bench-us-tax-guide");
    product.rows = product.rows.filter((r) => r.country !== "BR");
    expect(() => benchmarkDraft(product)).toThrow(/BR/);
  });

  it("formula prices that no longer match today's data throw as stale", () => {
    const product = byId("bench-design-templates");
    product.rows[3].formulaPriceCents += 1;
    expect(() => benchmarkDraft(product)).toThrow(/out of date/);
  });

  it("an audience profile that doesn't fit the schema throws", () => {
    const product = byId("bench-software-license");
    product.audience.regions[0].region = "Atlantis";
    expect(() => benchmarkDraft(product)).toThrow(/audience profile/);
  });
});
