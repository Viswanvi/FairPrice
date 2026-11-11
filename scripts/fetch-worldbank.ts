/**
 * Phase 8: download World Bank price-level data and write data/price-levels.json.
 *
 *   npx tsx scripts/fetch-worldbank.ts
 *
 * priceLevelRatio = PA.NUS.PPP (PPP conversion factor, GDP, LCU per international $)
 *                 / PA.NUS.FCRF (official exchange rate, LCU per US$, period average)
 * using, per country, the latest year where BOTH are present. US = 1.
 * World Bank 3-letter codes are mapped to ISO 3166-1 alpha-2 via the country list's iso2Code.
 * Aggregates (World, Euro area, income groups…) are excluded. Public data; no secrets.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const API = "https://api.worldbank.org/v2";
const FIRST_YEAR = 2010;
const LAST_YEAR = new Date().getUTCFullYear();
const PER_PAGE = 1000;
const OUT_FILE = path.join(process.cwd(), "data", "price-levels.json");
const TARGETS_FILE = path.join(process.cwd(), "data", "target-countries.json");

// Ratios outside this band almost always mean a currency redenomination or a data error.
const SANE_RATIO = { min: 0.05, max: 3 };

const metaSchema = z.object({ page: z.coerce.number(), pages: z.coerce.number() });

const indicatorRowSchema = z.object({
  countryiso3code: z.string(),
  date: z.string(),
  value: z.number().nullable(),
});

const countryRowSchema = z.object({
  id: z.string(),
  iso2Code: z.string(),
  name: z.string(),
  region: z.object({ value: z.string() }),
});

async function getJson(url: string): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      if (attempt >= 3) throw new Error(`GET ${url} failed: ${error instanceof Error ? error.message : error}`);
      console.log(`  retrying ${url} (${attempt})`);
    }
  }
}

/** Fetch every page of a World Bank v2 JSON endpoint. */
async function fetchAllPages<T>(baseUrl: string, rowSchema: z.ZodType<T>): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1, pages = 1; page <= pages; page++) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const body = await getJson(`${baseUrl}${sep}format=json&per_page=${PER_PAGE}&page=${page}`);
    const parsed = z.tuple([metaSchema, z.array(rowSchema).nullable()]).safeParse(body);
    if (!parsed.success) {
      throw new Error(`Unexpected World Bank response for ${baseUrl}: ${JSON.stringify(body).slice(0, 300)}`);
    }
    pages = parsed.data[0].pages;
    rows.push(...(parsed.data[1] ?? []));
  }
  return rows;
}

function byCountryYear(rows: z.infer<typeof indicatorRowSchema>[]): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const row of rows) {
    if (row.value === null || !row.countryiso3code) continue;
    const years = out.get(row.countryiso3code) ?? new Map<number, number>();
    years.set(Number(row.date), row.value);
    out.set(row.countryiso3code, years);
  }
  return out;
}

const round = (n: number, digits: number) => Number(n.toFixed(digits));

async function main(): Promise<void> {
  const dates = `date=${FIRST_YEAR}:${LAST_YEAR}`;
  const urls = {
    ppp: `${API}/country/all/indicator/PA.NUS.PPP?${dates}`,
    fx: `${API}/country/all/indicator/PA.NUS.FCRF?${dates}`,
    countries: `${API}/country`,
  };

  console.log("Fetching World Bank country list…");
  const countries = (await fetchAllPages(urls.countries, countryRowSchema)).filter(
    (c) => c.region.value !== "Aggregates" && /^[A-Z]{2}$/.test(c.iso2Code),
  );
  console.log(`  ${countries.length} countries (aggregates removed)`);

  console.log("Fetching PA.NUS.PPP…");
  const ppp = byCountryYear(await fetchAllPages(urls.ppp, indicatorRowSchema));
  console.log("Fetching PA.NUS.FCRF…");
  const fx = byCountryYear(await fetchAllPages(urls.fx, indicatorRowSchema));

  const included: {
    code: string;
    iso3: string;
    name: string;
    region: string;
    year: number;
    ppp: number;
    fx: number;
    ratio: number;
  }[] = [];
  const excluded: { code: string; name: string; reason: string }[] = [];

  for (const c of countries) {
    const p = ppp.get(c.id);
    const f = fx.get(c.id);
    const years = p && f ? [...p.keys()].filter((y) => f.has(y)) : [];
    if (years.length === 0) {
      excluded.push({ code: c.iso2Code, name: c.name, reason: "no year with both PPP and exchange rate" });
      continue;
    }
    const year = Math.max(...years);
    const pppValue = p!.get(year)!;
    const fxValue = f!.get(year)!;
    const ratio = pppValue / fxValue;
    if (!Number.isFinite(ratio) || ratio < SANE_RATIO.min || ratio > SANE_RATIO.max) {
      excluded.push({
        code: c.iso2Code,
        name: c.name,
        reason: `ratio ${round(ratio, 4)} for ${year} is outside ${SANE_RATIO.min}–${SANE_RATIO.max} (likely redenomination or data error)`,
      });
      continue;
    }
    included.push({
      code: c.iso2Code,
      iso3: c.id,
      name: c.name,
      region: c.region.value,
      year,
      ppp: round(pppValue, 6),
      fx: round(fxValue, 6),
      ratio: round(ratio, 4),
    });
  }

  included.sort((a, b) => a.code.localeCompare(b.code));
  excluded.sort((a, b) => a.code.localeCompare(b.code));

  const output = {
    note:
      "Price-level ratio per country = PPP conversion factor (PA.NUS.PPP) / official exchange rate (PA.NUS.FCRF), " +
      "latest year with both values. US = 1. region is the World Bank region. Generated by scripts/fetch-worldbank.ts; do not edit by hand.",
    source: {
      publisher: "World Bank, World Development Indicators (CC BY 4.0)",
      ppp: `${urls.ppp}&format=json`,
      fx: `${urls.fx}&format=json`,
      countries: `${urls.countries}?format=json`,
    },
    fetchedAt: new Date().toISOString(),
    countries: included,
    excluded,
  };
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${included.length} countries to data/price-levels.json (${excluded.length} excluded)`);

  // Report on the demo target countries.
  const targets = (JSON.parse(readFileSync(TARGETS_FILE, "utf8")) as { countries: { code: string }[] }).countries;
  const index = new Map(included.map((c) => [c.code, c]));
  console.log("\nTarget countries:");
  const missing: string[] = [];
  for (const t of targets) {
    const c = index.get(t.code);
    if (!c) {
      missing.push(t.code);
      const why = excluded.find((e) => e.code === t.code)?.reason ?? "not in World Bank country list";
      console.log(`  ${t.code}  MISSING — ${why}`);
    } else {
      console.log(`  ${t.code}  ${c.ratio.toFixed(4).padStart(7)}  (${c.year})  ${c.name}`);
    }
  }
  if (excluded.length) {
    console.log("\nExcluded:");
    for (const e of excluded) console.log(`  ${e.code}  ${e.name}: ${e.reason}`);
  }
  if (missing.length) {
    console.error(`\n${missing.length} target countries have no usable data: ${missing.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
