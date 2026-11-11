import { describe, expect, it } from "vitest";
import { clientIp, displayCountry, isIsoCountry, overrideCountry } from "./country";

const headers = (h: Record<string, string>) => new Headers(h);

describe("clientIp", () => {
  it("takes the first x-forwarded-for hop", () => {
    expect(clientIp(headers({ "x-forwarded-for": "49.36.10.1, 10.0.0.2, 172.16.0.1" }))).toBe("49.36.10.1");
  });

  it("strips ports and IPv6 brackets", () => {
    expect(clientIp(headers({ "x-forwarded-for": "49.36.10.1:5123" }))).toBe("49.36.10.1");
    expect(clientIp(headers({ "x-forwarded-for": "[2401:4900::1]:443" }))).toBe("2401:4900::1");
    expect(clientIp(headers({ "x-forwarded-for": "2401:4900::1" }))).toBe("2401:4900::1");
  });

  it("falls back to x-real-ip, else null", () => {
    expect(clientIp(headers({ "x-real-ip": "8.8.8.8" }))).toBe("8.8.8.8");
    expect(clientIp(headers({}))).toBeNull();
  });
});

describe("isIsoCountry / overrideCountry", () => {
  it("accepts real ISO codes, case-insensitive for overrides", () => {
    expect(isIsoCountry("IN")).toBe(true);
    expect(overrideCountry("in")).toBe("IN");
    expect(overrideCountry(" br ")).toBe("BR");
  });

  it("rejects junk and unknown codes", () => {
    for (const bad of ["", "IND", "1N", "ZZ", "XX", null, undefined]) {
      expect(overrideCountry(bad as string | null | undefined)).toBeNull();
    }
  });
});

describe("displayCountry", () => {
  const lookup = (ip: string) => (ip === "49.36.10.1" ? "IN" : ip === "8.8.8.8" ? "US" : null);

  it("uses the override only when enabled", async () => {
    const h = headers({ "x-forwarded-for": "8.8.8.8" });
    expect(await displayCountry({ headers: h, as: "IN", overrideEnabled: true }, lookup)).toEqual({
      country: "IN",
      overridden: true,
      source: "override",
    });
    expect(await displayCountry({ headers: h, as: "IN", overrideEnabled: false }, lookup)).toEqual({
      country: "US",
      overridden: false,
      source: "ip",
    });
  });

  it("ignores an invalid override and uses the IP", async () => {
    const h = headers({ "x-forwarded-for": "49.36.10.1" });
    expect(await displayCountry({ headers: h, as: "ZZ", overrideEnabled: true }, lookup)).toMatchObject({ country: "IN", source: "ip" });
  });

  it("returns no country for unknown IPs or no IP", async () => {
    expect(await displayCountry({ headers: headers({ "x-forwarded-for": "127.0.0.1" }), overrideEnabled: true }, lookup)).toEqual({
      country: null,
      overridden: false,
      source: "none",
    });
    expect(await displayCountry({ headers: headers({}), overrideEnabled: false }, lookup)).toMatchObject({ country: null });
  });

  it("works with the real geoip-lite data (country-only when .geoip exists)", async () => {
    const result = await displayCountry({ headers: headers({ "x-forwarded-for": "8.8.8.8" }), overrideEnabled: false });
    expect(result).toEqual({ country: "US", overridden: false, source: "ip" });
  });
});
