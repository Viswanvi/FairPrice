import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Display country for the buyer page — used for the SHOWN price only, never for eligibility
 * (CLAUDE.md). Eligibility always uses the PayPal payer country.
 *
 * Source order: demo override (?as=XX when DEMO_GEO_OVERRIDE=true) → client IP via geoip-lite → none.
 */

export interface DisplayCountry {
  country: string | null;
  overridden: boolean;
  source: "override" | "ip" | "none";
}

let regionNames: Intl.DisplayNames | null = null;

/** True for an upper-case ISO 3166-1 alpha-2 code that names a real region. */
export function isIsoCountry(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code)) return false;
  regionNames ??= new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });
  try {
    const name = regionNames.of(code);
    return Boolean(name) && name !== "Unknown Region";
  } catch {
    return false;
  }
}

/** First hop of x-forwarded-for (the client), else x-real-ip; brackets and ports removed. */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const raw = forwarded || headers.get("x-real-ip")?.trim();
  if (!raw) return null;
  const bracketed = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  const v4WithPort = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4WithPort) return v4WithPort[1];
  return raw;
}

/** A valid `?as=` override, upper-cased, or null. */
export function overrideCountry(as: string | null | undefined): string | null {
  const code = as?.trim().toUpperCase() ?? "";
  return isIsoCountry(code) ? code : null;
}

type Lookup = (ip: string) => string | null;

let geoipLookup: Lookup | null = null;

/** geoip-lite, loaded on first use with country-only data when .geoip/ exists (see scripts/prepare-geoip.mjs). */
async function defaultLookup(): Promise<Lookup> {
  if (geoipLookup) return geoipLookup;
  const countryOnly = path.join(process.cwd(), ".geoip");
  if (existsSync(path.join(countryOnly, "geoip-country.dat"))) process.env.GEODATADIR = countryOnly;
  const geoip = (await import("geoip-lite")).default;
  geoipLookup = (ip) => geoip.lookup(ip)?.country ?? null;
  return geoipLookup;
}

export async function displayCountry(
  input: { headers: Headers; as?: string | null; overrideEnabled: boolean },
  lookup?: Lookup,
): Promise<DisplayCountry> {
  if (input.overrideEnabled) {
    const override = overrideCountry(input.as);
    if (override) return { country: override, overridden: true, source: "override" };
  }
  const ip = clientIp(input.headers);
  if (!ip) return { country: null, overridden: false, source: "none" };
  const found = (lookup ?? (await defaultLookup()))(ip);
  return found && isIsoCountry(found)
    ? { country: found, overridden: false, source: "ip" }
    : { country: null, overridden: false, source: "none" };
}
