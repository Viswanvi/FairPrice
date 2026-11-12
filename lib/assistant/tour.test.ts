import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { numbersIn } from "@/lib/avatar/faithful";
import { heardOwnLine, isTourRequest, TOUR, TOUR_LANGS, TOUR_MARKERS, tourCommand } from "./tour";

const APP = path.join(process.cwd(), "app");

/** True when app/ has a page for this path ("/p/abc" matches app/p/[productId]/page.tsx). */
function routeExists(urlPath: string): boolean {
  const parts = new URL(urlPath, "http://x").pathname.split("/").filter(Boolean);
  const walk = (dir: string, rest: string[]): boolean => {
    if (rest.length === 0) return existsSync(path.join(dir, "page.tsx"));
    const exact = path.join(dir, rest[0]);
    if (existsSync(exact) && walk(exact, rest.slice(1))) return true;
    return readdirSync(dir)
      .filter((d) => /^\[[^.\]]+\]$/.test(d) && statSync(path.join(dir, d)).isDirectory())
      .some((d) => walk(path.join(dir, d), rest.slice(1)));
  };
  return walk(APP, parts);
}

function appSource(): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(APP);
  return out.join("\n");
}

describe("tour", () => {
  it("opens only real routes", () => {
    for (const step of TOUR) if (step.path) expect(routeExists(step.path), `${step.id} ${step.path}`).toBe(true);
  });

  it("points only at markers that exist on a page", () => {
    const src = appSource();
    const used = new Set(TOUR.flatMap((s) => [...(s.click ?? []), ...(s.highlight ? [s.highlight] : [])]));
    for (const marker of used) {
      expect(TOUR_MARKERS).toContain(marker);
      const literal = src.includes(`data-assistant-highlight="${marker}"`) || src.includes(`marker: "${marker}"`) || src.includes(`marker="${marker}"`);
      const stepTab = marker.startsWith("step_") && src.includes("data-assistant-highlight={`step_${s.id}`}");
      expect(literal || stepTab, marker).toBe(true);
    }
  });

  it("has every line in every tour language, with the same amounts as English", () => {
    for (const step of TOUR) {
      const en = numbersIn(step.line.en).sort();
      for (const lang of TOUR_LANGS) {
        expect(step.line[lang].trim().length, `${step.id} ${lang}`).toBeGreaterThan(0);
        expect(numbersIn(step.line[lang]).sort(), `${step.id} ${lang}`).toEqual(en);
      }
    }
  });

  it("says the product's approved prices: India 16 dollars, US 39 dollars", () => {
    const t3 = TOUR.find((s) => s.id === "T3")!;
    expect(t3.line.en).toContain("39 dollars");
    expect(t3.line.en).toContain("16 dollars");
  });

  it("never asks to hear a password, and hands Approve and PayPal to the person", () => {
    for (const step of TOUR) {
      expect(step.line.en.toLowerCase()).not.toMatch(/(say|tell me) (your|the) password/);
      expect(step.click ?? []).not.toContain("paypal_button");
    }
    expect(TOUR.find((s) => s.id === "T7")!.line.en).toContain("Please type it yourself");
  });

  it("ignores a command the guide's own line says, while that line plays", () => {
    const t4 = TOUR.find((s) => s.id === "T4")!;
    expect(heardOwnLine("skip", t4.line.en)).toBe(true); // "…or say skip"
    expect(heardOwnLine("skip", t4.line.hi)).toBe(true); // "…या स्किप बोलें"
    expect(heardOwnLine("stop", t4.line.en)).toBe(false); // the visitor can still say stop
    expect(heardOwnLine("skip", null)).toBe(false); // not speaking: every command counts
  });

  it("recognises a request for the tour, but not a passing mention of a demo", () => {
    for (const yes of ["can you walk me through the demo", "Show me around", "take the tour", "give me a quick demo", "मुझे टूर दिखाओ", "डेमो दिखाइए"]) {
      expect(isTourRequest(yes), yes).toBe(true);
    }
    for (const no of ["I need a figma template", "is this a demo product?", "let's pay", "मुझे टेम्पलेट चाहिए"]) {
      expect(isTourRequest(no), no).toBe(false);
    }
  });

  it("understands skip and stop in English and Hindi", () => {
    expect(tourCommand("skip")).toBe("skip");
    expect(tourCommand("please stop the tour")).toBe("stop");
    expect(tourCommand("स्किप करो")).toBe("skip");
    expect(tourCommand("रुको")).toBe("stop");
    expect(tourCommand("what is this")).toBeNull();
  });
});
