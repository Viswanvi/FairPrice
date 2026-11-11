import { describe, expect, it } from "vitest";
import { resultFromOrder, type OrderForResult } from "./messages";
import {
  defaultVoiceLanguage,
  LANGUAGE_INFO,
  NOT_CHARGED,
  VOICE_UI,
  priceSpeech,
  resultSpeech,
  spokenAmount,
  VOICE_LANGUAGES,
  type PriceSpeechInput,
} from "./voice";

const order = (o: Partial<OrderForResult>): OrderForResult => ({
  id: "ord_1",
  productId: "bench-design-templates",
  status: "CREATED",
  decision: null,
  payerCountry: null,
  shownCents: 1600,
  chargedCents: null,
  offerCents: null,
  ...o,
});

/** Every result the checkout can produce, built by the real server-side function. */
const RESULTS = {
  paidMatch: resultFromOrder(order({ status: "CAPTURED", decision: "MATCH", payerCountry: "IN", chargedCents: 1600 })),
  paidNoCountry: resultFromOrder(order({ status: "CAPTURED", decision: "MATCH", chargedCents: 1600 })),
  paidUnclear: resultFromOrder(order({ status: "CAPTURED", decision: "UNCLEAR", shownCents: 3900, chargedCents: 3900 })),
  paidCard: resultFromOrder(order({ status: "CAPTURED", decision: "NOT_PAYPAL", shownCents: 3900, chargedCents: 3900 })),
  traveler: resultFromOrder(order({ status: "CAPTURED", decision: "TRAVELER", payerCountry: "IN", shownCents: 3900, chargedCents: 1600 })),
  mismatch: resultFromOrder(order({ status: "VOIDED", decision: "MISMATCH", payerCountry: "US", offerCents: 3900 })),
  cardVoided: resultFromOrder(order({ status: "VOIDED", decision: "NOT_PAYPAL", offerCents: 3900 })),
  unclearVoided: resultFromOrder(order({ status: "VOIDED", decision: "UNCLEAR", offerCents: 3900 })),
  declined: resultFromOrder(order({ status: "DECLINED" })),
  review: resultFromOrder(order({ status: "NEEDS_REVIEW", shownCents: 1600 })),
  pending: resultFromOrder(order({ status: "CREATED" })),
};
const NOT_CHARGED_RESULTS = ["mismatch", "cardVoided", "unclearVoided", "declined", "pending"] as const;
const CHARGED_RESULTS = ["paidMatch", "paidNoCountry", "paidUnclear", "paidCard", "traveler"] as const;

const PRICES: Record<string, PriceSpeechInput> = {
  fairIndia: { priceCents: 1600, standardCents: 3900, shownCountry: "IN", inTable: true, fairPriceNote: true },
  fullUS: { priceCents: 3900, standardCents: 3900, shownCountry: "US", inTable: true, fairPriceNote: false },
  untabledFrance: { priceCents: 3900, standardCents: 3900, shownCountry: "FR", inTable: false, fairPriceNote: false },
  noCountry: { priceCents: 3900, standardCents: 3900, shownCountry: null, inTable: false, fairPriceNote: false },
};

describe("VOICE_UI and LANGUAGE_INFO", () => {
  it("every language has its own button labels and a speech language", () => {
    for (const lang of VOICE_LANGUAGES) {
      expect(VOICE_UI[lang].listen).toBeTruthy();
      expect(VOICE_UI[lang].stop).toBeTruthy();
      expect(VOICE_UI[lang].noVoice).toBeTruthy();
      expect(LANGUAGE_INFO[lang].speechLang).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
      expect(LANGUAGE_INFO[lang].voicePrefixes.length).toBeGreaterThan(0);
    }
    expect(new Set(VOICE_LANGUAGES.map((l) => VOICE_UI[l].listen)).size).toBe(VOICE_LANGUAGES.length);
  });
});

describe("defaultVoiceLanguage", () => {
  it("picks the main language of the visitor's country, else English", () => {
    expect(defaultVoiceLanguage("IN")).toBe("hi");
    expect(defaultVoiceLanguage("BR")).toBe("pt-BR");
    for (const c of ["MX", "AR", "CO", "PE", "CL", "ES"]) expect(defaultVoiceLanguage(c)).toBe("es");
    for (const c of ["US", "GB", "FR", "JP", null]) expect(defaultVoiceLanguage(c)).toBe("en");
    expect(defaultVoiceLanguage("in")).toBe("hi");
  });
});

describe("spokenAmount", () => {
  it("says amounts as words a voice reads correctly", () => {
    expect(spokenAmount("en", 2970)).toBe("$29.70");
    expect(spokenAmount("hi", 1600)).toBe("16 डॉलर");
    expect(spokenAmount("hi", 2970)).toBe("29 डॉलर 70 सेंट");
    expect(spokenAmount("pt-BR", 1600)).toBe("16 dólares");
    expect(spokenAmount("pt-BR", 2970)).toBe("29 dólares e 70 centavos");
    expect(spokenAmount("pt-BR", 100)).toBe("1 dólar");
    expect(spokenAmount("es", 1600)).toBe("16 dólares");
    expect(spokenAmount("es", 2970)).toBe("29 dólares con 70 centavos");
    expect(spokenAmount("es", 101)).toBe("1 dólar con 1 centavo");
  });
});

describe("priceSpeech", () => {
  it("English matches the page: price, country, and the PayPal promise", () => {
    expect(priceSpeech("en", PRICES.fairIndia)).toBe(
      "Your price is $16, the fair price for India. Fair prices need a PayPal account; card payments pay the standard price. " +
        "Before any money is taken, PayPal confirms your account's country, and you're never charged more than the price you approve.",
    );
    expect(priceSpeech("en", PRICES.fullUS)).toContain("the fair price for the United States");
    expect(priceSpeech("en", PRICES.untabledFrance)).toContain("Your price is $39, the price for France.");
    expect(priceSpeech("en", PRICES.noCountry)).toContain("Your price is $39, the standard price.");
  });

  it("each language names the country in that language and says the amount", () => {
    expect(priceSpeech("hi", PRICES.fairIndia)).toContain("भारत");
    expect(priceSpeech("hi", PRICES.fairIndia)).toContain("16 डॉलर");
    expect(priceSpeech("pt-BR", PRICES.fairIndia)).toContain("Índia");
    expect(priceSpeech("es", PRICES.fullUS)).toContain("Estados Unidos");
  });

  it.each(VOICE_LANGUAGES.flatMap((lang) => Object.entries(PRICES).map(([name, input]) => [lang, name, input] as const)))(
    "%s / %s: complete, no formulas, the card note only when the page shows it",
    (lang, name, input) => {
      const text = priceSpeech(lang, input);
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(/undefined|NaN|null|\{|\}|%|×|=/);
      if (lang !== "en") expect(text).not.toContain("$");
      const withNote = priceSpeech(lang, { ...input, fairPriceNote: true });
      const withoutNote = priceSpeech(lang, { ...input, fairPriceNote: false });
      expect(withNote.length).toBeGreaterThan(withoutNote.length);
      expect(name).toBeTruthy();
    },
  );
});

describe("resultSpeech", () => {
  it("English is exactly the message the page shows", () => {
    for (const result of Object.values(RESULTS)) expect(resultSpeech("en", result)).toBe(result.message);
  });

  it.each(VOICE_LANGUAGES.flatMap((lang) => Object.keys(RESULTS).map((name) => [lang, name] as const)))(
    "%s / %s: complete and with no placeholders",
    (lang, name) => {
      const text = resultSpeech(lang, RESULTS[name as keyof typeof RESULTS]);
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/undefined|NaN|null|\{|\}/);
      if (lang !== "en") expect(text).not.toContain("$");
    },
  );

  it.each(VOICE_LANGUAGES.flatMap((lang) => NOT_CHARGED_RESULTS.map((name) => [lang, name] as const)))(
    "%s / %s: says no money was taken",
    (lang, name) => {
      expect(resultSpeech(lang, RESULTS[name])).toContain(NOT_CHARGED[lang]);
    },
  );

  it.each(VOICE_LANGUAGES.flatMap((lang) => CHARGED_RESULTS.map((name) => [lang, name] as const)))(
    "%s / %s: says the amount actually charged, and never 'not charged'",
    (lang, name) => {
      const result = RESULTS[name];
      const text = resultSpeech(lang, result);
      expect(text).toContain(spokenAmount(lang, result.chargedCents));
      expect(text).not.toContain(NOT_CHARGED[lang]);
    },
  );

  it("the VPN case states the account country without accusing", () => {
    expect(resultSpeech("hi", RESULTS.mismatch)).toContain("संयुक्त राज्य");
    expect(resultSpeech("pt-BR", RESULTS.mismatch)).toContain("Estados Unidos");
    expect(resultSpeech("es", RESULTS.mismatch)).toContain("Estados Unidos");
    for (const lang of VOICE_LANGUAGES) {
      expect(resultSpeech(lang, RESULTS.mismatch).toLowerCase()).not.toMatch(/vpn|fraud|fraude|धोखा/);
      expect(resultSpeech(lang, RESULTS.mismatch)).toContain(spokenAmount(lang, 3900));
    }
  });

  it("the traveler and review cases use the amount the buyer approved", () => {
    expect(resultSpeech("es", RESULTS.traveler)).toContain(spokenAmount("es", 3900));
    expect(resultSpeech("hi", RESULTS.review)).toContain(spokenAmount("hi", 1600));
  });
});
