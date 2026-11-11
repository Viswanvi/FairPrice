import { z } from "zod";
import feesJson from "../../data/fees.json";
import priceLevelsJson from "../../data/price-levels.json";
import targetCountriesJson from "../../data/target-countries.json";
import type { FeeConfig } from "./formula";

/**
 * Typed, validated access to the committed pricing data files. Values are configuration,
 * never hard-coded: edit the JSON (or re-run scripts/fetch-worldbank.ts), not this file.
 */

const isoCode = z.string().regex(/^[A-Z]{2}$/);

export const REGIONS = [
  "North America",
  "Latin America",
  "Western Europe",
  "Eastern Europe",
  "Middle East and North Africa",
  "Sub-Saharan Africa",
  "South Asia",
  "Southeast Asia",
  "East Asia",
  "Oceania",
] as const;
export const regionSchema = z.enum(REGIONS);
export type Region = z.infer<typeof regionSchema>;

const priceLevelSchema = z.object({
  code: isoCode,
  iso3: z.string(),
  name: z.string(),
  region: z.string(),
  year: z.number().int(),
  ppp: z.number().positive(),
  fx: z.number().positive(),
  ratio: z.number().positive(),
});
export type PriceLevel = z.infer<typeof priceLevelSchema>;

const priceLevelsFileSchema = z.object({
  fetchedAt: z.string(),
  source: z.record(z.string(), z.string()),
  countries: z.array(priceLevelSchema).min(1),
});

const targetCountriesFileSchema = z.object({
  regions: z.array(regionSchema),
  countries: z.array(z.object({ code: isoCode, region: regionSchema })).min(1),
});
export type TargetCountry = { code: string; region: Region };

const feesFileSchema = z.object({
  percent: z.number().min(0).max(1),
  fixedUsd: z.number().min(0),
  intlPercent: z.number().min(0).max(1),
  maxFeeShare: z.number().gt(0).max(1),
  note: z.string(),
});

let cache: {
  levels: Map<string, PriceLevel>;
  targets: TargetCountry[];
  fees: FeeConfig;
  fetchedAt: string;
} | null = null;

function load() {
  if (cache) return cache;
  const levels = priceLevelsFileSchema.parse(priceLevelsJson);
  const targets = targetCountriesFileSchema.parse(targetCountriesJson);
  const fees = feesFileSchema.parse(feesJson);
  cache = {
    levels: new Map(levels.countries.map((c) => [c.code, c])),
    targets: targets.countries,
    fees: { percent: fees.percent, fixedUsd: fees.fixedUsd, intlPercent: fees.intlPercent, maxFeeShare: fees.maxFeeShare },
    fetchedAt: levels.fetchedAt,
  };
  return cache;
}

/** All countries with World Bank price-level data, keyed by ISO alpha-2 code. */
export function priceLevels(): ReadonlyMap<string, PriceLevel> {
  return load().levels;
}

/** Price-level ratio for a country, or null when the World Bank has no usable data. */
export function priceLevelRatio(code: string): number | null {
  return load().levels.get(code.toUpperCase())?.ratio ?? null;
}

/** The ~40 demo target countries the AI prices individually, with their FairPrice region. */
export function targetCountries(): readonly TargetCountry[] {
  return load().targets;
}

/** Fee configuration from data/fees.json. */
export function feeConfig(): FeeConfig {
  return load().fees;
}

/** When the World Bank data was fetched (ISO timestamp). */
export function priceLevelsFetchedAt(): string {
  return load().fetchedAt;
}
