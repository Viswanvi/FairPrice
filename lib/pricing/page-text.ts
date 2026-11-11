import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Fetch a seller's product page and reduce it to plain text for the audience analysis.
 *
 * The server fetches a URL the seller typed, so it is guarded against server-side request
 * forgery: http(s) only, default ports only, no credentials in the URL, every hostname
 * (including each redirect hop) must resolve only to public addresses, 5 s timeout, 1 MB cap.
 * Known gap: a hostname could re-resolve between the check and the fetch (DNS rebinding);
 * acceptable for a sandbox demo, noted in docs/PROGRESS.md.
 */

export type PageFetchErrorCode =
  | "invalid_url"
  | "blocked_address"
  | "fetch_failed"
  | "unsupported_content"
  | "too_many_redirects";

export class PageFetchError extends Error {
  constructor(
    public readonly code: PageFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PageFetchError";
  }
}

function ipv4Blocked(ip: string): boolean {
  const [a, b, c] = ip.split(".").map(Number);
  return (
    a === 0 || // "this" network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast, reserved, broadcast
  );
}

/** True for loopback, private, link-local, multicast, reserved and documentation addresses. */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(ip);
  if (version === 4) return ipv4Blocked(ip);
  if (version !== 6) return true; // not an IP at all: refuse

  // IPv4-mapped / -compatible forms: ::ffff:a.b.c.d or ::ffff:7f00:1
  const mappedDotted = ip.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted) return ipv4Blocked(mappedDotted[1]);
  const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return ipv4Blocked(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }

  return (
    ip === "::" ||
    ip === "::1" ||
    /^f[cd]/.test(ip) || // unique local fc00::/7
    /^fe[89ab]/.test(ip) || // link-local fe80::/10
    ip.startsWith("ff") || // multicast
    ip.startsWith("2001:db8") || // documentation
    ip.startsWith("64:ff9b:") // NAT64 can reach IPv4 private space
  );
}

/** Throws PageFetchError unless the URL is http(s) on a default port and resolves only to public IPs. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PageFetchError("invalid_url", "That doesn't look like a valid link.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PageFetchError("invalid_url", "Only http and https links are supported.");
  }
  if (url.username || url.password) {
    throw new PageFetchError("invalid_url", "Links with a username or password aren't supported.");
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new PageFetchError("invalid_url", "Links must use the standard web port.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
    } catch {
      throw new PageFetchError("fetch_failed", "We couldn't find that website.");
    }
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new PageFetchError("blocked_address", "That link points to a private or local address.");
  }
  return url;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Plain text from HTML: title, meta description, then visible body text. */
export function htmlToText(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const description =
    html.match(/<meta[^>]+(?:name|property)=["'](?:og:)?description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["'](?:og:)?description["']/i)?.[1];

  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return [title, description, body]
    .filter((part): part is string => Boolean(part))
    .map((part) =>
      decodeEntities(part)
        .split("\n")
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n"),
    )
    .filter(Boolean)
    .join("\n\n");
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const buffer = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.min(chunk.byteLength, buffer.byteLength - offset));
    buffer.set(slice, offset);
    offset += slice.byteLength;
    if (offset >= buffer.byteLength) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

export async function fetchProductPageText(
  rawUrl: string,
  options: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number } = {},
): Promise<{ text: string; finalUrl: string }> {
  const { timeoutMs = 5000, maxBytes = 1_000_000, maxRedirects = 3 } = options;
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = await assertPublicUrl(current);
    let res: Response;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "text/html,text/plain;q=0.9", "User-Agent": "FairPrice/0.1 (product page reader)" },
      });
    } catch {
      throw new PageFetchError("fetch_failed", "We couldn't load that page in time.");
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new PageFetchError("fetch_failed", "That page redirected without a destination.");
      current = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) throw new PageFetchError("fetch_failed", `That page returned an error (HTTP ${res.status}).`);

    const type = res.headers.get("content-type") ?? "";
    const isHtml = type.includes("text/html") || type.includes("application/xhtml");
    if (!isHtml && !type.includes("text/plain")) {
      throw new PageFetchError("unsupported_content", "That link isn't a web page we can read.");
    }
    const body = await readCapped(res, maxBytes);
    return { text: isHtml ? htmlToText(body) : body.trim(), finalUrl: url.toString() };
  }
  throw new PageFetchError("too_many_redirects", "That link redirected too many times.");
}
