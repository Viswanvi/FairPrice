import { describe, expect, it } from "vitest";
import { numbersIn, saidOnlyGivenNumbers } from "./faithful";

describe("saidOnlyGivenNumbers", () => {
  const line = "This template pack is 39 dollars as standard, but the fair price for India is 16 dollars.";

  it("passes the exact text, and a transcript cut short at the end", () => {
    expect(saidOnlyGivenNumbers(line, line)).toBe(true);
    expect(saidOnlyGivenNumbers(line, "This template pack is 39 dollars as standard, but the fair price for India is 16")).toBe(true);
    expect(saidOnlyGivenNumbers(line, "This template pack is 39 dollars")).toBe(true);
  });

  it("fails a changed or invented amount", () => {
    expect(saidOnlyGivenNumbers(line, "the fair price for India is 15 dollars")).toBe(false);
    expect(saidOnlyGivenNumbers(line, "39 dollars, or about 3200 rupees")).toBe(false);
    expect(saidOnlyGivenNumbers("You have not been charged.", "You paid 16 dollars.")).toBe(false);
  });

  it("reads Devanagari digits and thousands separators as the same number", () => {
    expect(numbersIn("कीमत १६ डॉलर, 1,200 लोग")).toEqual(["16", "1200"]);
    expect(saidOnlyGivenNumbers("आपकी कीमत 16 डॉलर है।", "आपकी कीमत १६ डॉलर है।")).toBe(true);
    expect(saidOnlyGivenNumbers("आपकी कीमत 16 डॉलर है।", "आपकी कीमत १५ डॉलर है।")).toBe(false);
  });
});
