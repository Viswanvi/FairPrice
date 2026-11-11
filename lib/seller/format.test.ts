import { describe, expect, it } from "vitest";
import {
  biggestDifferences,
  countryName,
  embedSnippet,
  formatDateTimeUtc,
  formatUsd,
  parseDollarsToCents,
  priceDifferences,
  shortHash,
} from "./format";

describe("formatUsd", () => {
  it("drops cents for whole dollars and keeps two decimals otherwise", () => {
    expect(formatUsd(3500)).toBe("$35");
    expect(formatUsd(3499)).toBe("$34.99");
    expect(formatUsd(3450)).toBe("$34.50");
    expect(formatUsd(129900)).toBe("$1,299");
  });
});

describe("parseDollarsToCents", () => {
  it.each([
    ["35", 3500],
    ["34.99", 3499],
    ["34.5", 3450],
    ["$99", 9900],
    ["1,299.00", 129900],
    [" 0 ", 0],
  ])("parses %s", (input, cents) => {
    expect(parseDollarsToCents(input)).toBe(cents);
  });

  it.each(["", "abc", "-5", "34.999", "3.4.5", "1e3", "$"])("rejects %s", (input) => {
    expect(parseDollarsToCents(input)).toBeNull();
  });

  it("avoids float rounding errors", () => {
    expect(parseDollarsToCents("0.29")).toBe(29);
    expect(parseDollarsToCents("28.99")).toBe(2899);
  });
});

describe("countryName", () => {
  it("gives English names and falls back to the code", () => {
    expect(countryName("IN")).toBe("India");
    expect(countryName("eg")).toBe("Egypt");
    expect(countryName("1W")).toBe("1W");
  });
});

describe("priceDifferences / biggestDifferences", () => {
  const ai = [
    { country: "US", priceCents: 9900 },
    { country: "IN", priceCents: 2700 },
    { country: "BR", priceCents: 3400 },
    { country: "DE", priceCents: 6500 },
  ];
  const formula = [
    { country: "US", priceCents: 9900 },
    { country: "IN", priceCents: 2670 },
    { country: "BR", priceCents: 4069 },
    { country: "DE", priceCents: 7140 },
  ];

  it("computes the difference in cents and percent, largest first", () => {
    expect(priceDifferences(ai, formula).map((d) => [d.country, d.diffCents, d.diffPct])).toEqual([
      ["BR", -669, -16],
      ["DE", -640, -9],
      ["IN", 30, 1],
      ["US", 0, 0],
    ]);
  });

  it("returns the n biggest, skipping zero differences", () => {
    expect(biggestDifferences(ai, formula, 2)).toEqual(["BR", "DE"]);
    expect(biggestDifferences(ai, formula, 10)).toEqual(["BR", "DE", "IN"]);
  });
});

describe("embedSnippet", () => {
  it("builds a one-line iframe and escapes the title", () => {
    const s = embedSnippet("https://fairprice.example/p/abc", 'Course "Pro" <2026>');
    expect(s).toBe(
      '<iframe src="https://fairprice.example/p/abc" title="Course &quot;Pro&quot; &lt;2026&gt;" width="100%" height="680" style="border:0;max-width:480px" loading="lazy"></iframe>',
    );
    expect(s).not.toContain("\n");
  });
});

describe("formatDateTimeUtc", () => {
  it("formats in UTC with a fixed locale", () => {
    expect(formatDateTimeUtc("2026-11-11T06:34:48.000Z")).toBe("11 Nov 2026, 06:34 UTC");
  });
});

describe("shortHash", () => {
  it("keeps the first 12 characters", () => {
    expect(shortHash("01407de98555abcdef")).toBe("01407de98555");
  });
});
