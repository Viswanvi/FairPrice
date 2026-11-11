/**
 * Strip personal data from PayPal payloads before they are printed, logged or stored
 * (CLAUDE.md money-safety rule 9), and locate country fields without assuming where they are.
 * Used by the spike script, lib/db (webhook payloads, audit detail) and lib/paypal.
 *
 * Kept: IDs, statuses, amounts, links and every country_code.
 * Removed: names, emails, phones, street/city/postcode, birth dates, tax IDs, tokens.
 */

export const REDACTED = "[redacted]";

const REDACT_KEYS = new Set([
  // names (also `name` when it is an object — see below)
  "given_name",
  "surname",
  "middle_name",
  "full_name",
  "alternate_full_name",
  "prefix",
  "suffix",
  // contact
  "email",
  "email_address",
  "phone",
  "phone_number",
  "national_number",
  // address parts other than country_code
  "address_line_1",
  "address_line_2",
  "address_line_3",
  "admin_area_1",
  "admin_area_2",
  "admin_area_3",
  "admin_area_4",
  "postal_code",
  // identity
  "birth_date",
  "tax_info",
  "tax_id",
  // credentials
  "access_token",
  "refresh_token",
  "id_token",
]);

const EMAIL_PATTERN = /[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}/g;

export function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const lower = key.toLowerCase();
      // `name` is a person's name when it is an object; a string `name` is an error code.
      const isPersonName = lower === "name" && child !== null && typeof child === "object";
      out[key] = REDACT_KEYS.has(lower) || isPersonName ? REDACTED : sanitize(child);
    }
    return out;
  }
  if (typeof value === "string") return value.replace(EMAIL_PATTERN, "[redacted-email]");
  return value;
}

export interface CountryField {
  path: string;
  value: unknown;
}

/** Every field named country_code anywhere in the value, with its full path. */
export function findCountryCodes(value: unknown, path = ""): CountryField[] {
  if (Array.isArray(value)) {
    return value.flatMap((child, i) => findCountryCodes(child, `${path}[${i}]`));
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = path ? `${path}.${key}` : key;
    if (key === "country_code") return [{ path: childPath, value: child }];
    return findCountryCodes(child, childPath);
  });
}

/** Read a path like "purchase_units[0].payments.authorizations[0].id". Undefined if absent. */
export function getAtPath(value: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
