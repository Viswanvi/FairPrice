import { countryPhrase, type CheckoutResult } from "./messages";
import { formatUsd } from "@/lib/seller/format";

/**
 * Native-language explanations for the buyer page, shown as text and read aloud by the
 * browser's built-in voice (app/_components/voice.tsx). Pure: no I/O.
 *
 * The sentences are fixed, written translations of the page's English copy. No AI writes or
 * changes them at runtime, so nothing about money is improvised. They follow the same copy rules
 * (CLAUDE.md): always say whether money moved, never accuse, one plain sentence per point, no
 * formulas. Amounts come only from the server's quote or checkout result. English reuses the
 * page's exact text.
 */

export const VOICE_LANGUAGES = ["en", "hi", "pt-BR", "es"] as const;
export type VoiceLanguage = (typeof VOICE_LANGUAGES)[number];

export const LANGUAGE_INFO: Record<VoiceLanguage, { label: string; speechLang: string; voicePrefixes: string[] }> = {
  en: { label: "English", speechLang: "en-US", voicePrefixes: ["en-us", "en"] },
  hi: { label: "हिन्दी (Hindi)", speechLang: "hi-IN", voicePrefixes: ["hi"] },
  "pt-BR": { label: "Português (Brasil)", speechLang: "pt-BR", voicePrefixes: ["pt-br", "pt"] },
  es: { label: "Español", speechLang: "es-ES", voicePrefixes: ["es"] },
};

/** Labels for the Listen control, in each language, so the button is findable without English. */
export const VOICE_UI: Record<VoiceLanguage, { listen: string; stop: string; noVoice: string }> = {
  en: { listen: "Listen", stop: "Stop", noVoice: "This device has no English voice, so it can't read this aloud." },
  hi: {
    listen: "सुनें",
    stop: "रोकें",
    noVoice: "इस डिवाइस पर हिन्दी आवाज़ उपलब्ध नहीं है, इसलिए यह पढ़कर नहीं सुनाया जा सकता। ऊपर लिखा संदेश वही बताता है।",
  },
  "pt-BR": {
    listen: "Ouvir",
    stop: "Parar",
    noVoice: "Este aparelho não tem voz em português, então não pode ler em voz alta. O texto acima diz o mesmo.",
  },
  es: {
    listen: "Escuchar",
    stop: "Detener",
    noVoice: "Este dispositivo no tiene voz en español, así que no puede leerlo en voz alta. El texto de arriba dice lo mismo.",
  },
};

/** The phrase every "money did not move" result contains, per language (tested). */
export const NOT_CHARGED: Record<VoiceLanguage, string> = {
  en: "You have not been charged.",
  hi: "आपसे कोई पैसा नहीं लिया गया है।",
  "pt-BR": "Você não foi cobrado.",
  es: "No se te ha cobrado nada.",
};

const SPANISH_SPEAKING = new Set([
  "ES", "MX", "AR", "CO", "PE", "CL", "EC", "VE", "GT", "CU", "BO", "DO", "HN", "PY", "SV", "NI", "CR", "PA", "UY", "PR",
]);

/** The language the explanation starts in for a visitor's display country. */
export function defaultVoiceLanguage(country: string | null): VoiceLanguage {
  const code = country?.toUpperCase() ?? "";
  if (code === "IN") return "hi";
  if (code === "BR" || code === "PT") return "pt-BR";
  if (SPANISH_SPEAKING.has(code)) return "es";
  return "en";
}

/** An amount as words a voice reads correctly ("29 dólares con 70 centavos"). English keeps "$29.70". */
export function spokenAmount(lang: VoiceLanguage, cents: number): string {
  if (lang === "en") return formatUsd(cents);
  const dollars = Math.floor(cents / 100);
  const rest = cents % 100;
  switch (lang) {
    case "hi":
      return rest ? `${dollars} डॉलर ${rest} सेंट` : `${dollars} डॉलर`;
    case "pt-BR": {
      const d = `${dollars} ${dollars === 1 ? "dólar" : "dólares"}`;
      return rest ? `${d} e ${rest} ${rest === 1 ? "centavo" : "centavos"}` : d;
    }
    case "es": {
      const d = `${dollars} ${dollars === 1 ? "dólar" : "dólares"}`;
      return rest ? `${d} con ${rest} ${rest === 1 ? "centavo" : "centavos"}` : d;
    }
  }
}

const regionNames = new Map<string, Intl.DisplayNames>();

/** The country's name in the language ("भारत", "Índia"); English adds "the" where needed. */
function countryIn(lang: VoiceLanguage, code: string): string {
  if (lang === "en") return countryPhrase(code);
  try {
    let names = regionNames.get(lang);
    if (!names) {
      names = new Intl.DisplayNames([lang], { type: "region" });
      regionNames.set(lang, names);
    }
    return names.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export interface PriceSpeechInput {
  priceCents: number;
  standardCents: number;
  /** Display country (IP or demo override); never used for eligibility. */
  shownCountry: string | null;
  /** True when the approved table has a price for the display country. */
  inTable: boolean;
  /** True when the page shows "Fair prices need a PayPal account; card payments pay the standard price." */
  fairPriceNote: boolean;
}

interface Phrases {
  fairPrice: (amount: string, country: string) => string;
  countryPrice: (amount: string, country: string) => string;
  standardPrice: (amount: string) => string;
  fairPriceNote: string;
  promise: string;
  paid: (amount: string, country: string | null) => string;
  paidUnclear: (amount: string) => string;
  paidCard: (amount: string) => string;
  traveler: (charged: string, shown: string) => string;
  mismatch: (country: string, offer: string) => string;
  cardVoided: (offer: string) => string;
  unclearVoided: (offer: string) => string;
  declined: string;
  review: (shown: string) => string;
  pending: string;
}

const PHRASES: Record<Exclude<VoiceLanguage, "en">, Phrases> = {
  hi: {
    fairPrice: (a, c) => `आपकी कीमत ${a} है, जो ${c} के लिए उचित कीमत है।`,
    countryPrice: (a, c) => `आपकी कीमत ${a} है, जो ${c} के लिए कीमत है।`,
    standardPrice: (a) => `आपकी कीमत ${a} है, जो मानक कीमत है।`,
    fairPriceNote: "उचित कीमत के लिए PayPal खाता ज़रूरी है; कार्ड से भुगतान करने पर मानक कीमत लगती है।",
    promise:
      "कोई भी पैसा लेने से पहले PayPal आपके खाते के देश की पुष्टि करता है, और आपसे आपकी मंज़ूर की गई कीमत से ज़्यादा कभी नहीं लिया जाएगा।",
    paid: (a, c) => (c ? `आपने ${a} का भुगतान किया, जो ${c} के लिए उचित कीमत है।` : `आपने ${a} का भुगतान किया।`),
    paidUnclear: (a) => `हम आपके देश की पुष्टि नहीं कर सके, इसलिए मानक कीमत लागू हुई। आपने ${a} का भुगतान किया।`,
    paidCard: (a) => `आपने ${a} का भुगतान किया, जो कार्ड भुगतान के लिए मानक कीमत है।`,
    traveler: (charged, shown) => `आपसे ${charged} लिए गए, जो आपके देश के लिए उचित कीमत है, ${shown} नहीं।`,
    mismatch: (c, o) => `आपका PayPal खाता ${c} में पंजीकृत है। वहाँ की कीमत ${o} है। ${NOT_CHARGED.hi}`,
    cardVoided: (o) => `उचित कीमत के लिए PayPal खाता ज़रूरी है, इसलिए कार्ड भुगतान पर मानक कीमत ${o} लगती है। ${NOT_CHARGED.hi}`,
    unclearVoided: (o) => `हम आपके देश की पुष्टि नहीं कर सके, इसलिए मानक कीमत ${o} लागू होती है। ${NOT_CHARGED.hi}`,
    declined: `आपका भुगतान मंज़ूर नहीं हुआ। ${NOT_CHARGED.hi}`,
    review: (s) => `हम PayPal के साथ आपके भुगतान की पुष्टि कर रहे हैं। आपसे ${s} से ज़्यादा नहीं लिया जाएगा।`,
    pending: `आपका भुगतान अभी मंज़ूर नहीं हुआ है। ${NOT_CHARGED.hi}`,
  },
  "pt-BR": {
    fairPrice: (a, c) => `Seu preço é ${a}, o preço justo para o seu país: ${c}.`,
    countryPrice: (a, c) => `Seu preço é ${a}, o preço para o seu país: ${c}.`,
    standardPrice: (a) => `Seu preço é ${a}, o preço padrão.`,
    fairPriceNote: "Preços justos exigem uma conta PayPal; pagamentos com cartão pagam o preço padrão.",
    promise: "Antes de qualquer cobrança, o PayPal confirma o país da sua conta, e você nunca paga mais do que o preço que aprovou.",
    paid: (a, c) => (c ? `Você pagou ${a}, o preço justo para o seu país: ${c}.` : `Você pagou ${a}.`),
    paidUnclear: (a) => `Não conseguimos confirmar o seu país, então o preço padrão foi aplicado. Você pagou ${a}.`,
    paidCard: (a) => `Você pagou ${a}, o preço padrão para pagamentos com cartão.`,
    traveler: (charged, shown) => `Você pagou ${charged}, o preço justo para o seu país, e não ${shown}.`,
    mismatch: (c, o) => `O país registrado na sua conta PayPal é ${c}. O preço lá é ${o}. ${NOT_CHARGED["pt-BR"]}`,
    cardVoided: (o) =>
      `Preços justos exigem uma conta PayPal, então pagamentos com cartão pagam o preço padrão de ${o}. ${NOT_CHARGED["pt-BR"]}`,
    unclearVoided: (o) => `Não conseguimos confirmar o seu país, então vale o preço padrão de ${o}. ${NOT_CHARGED["pt-BR"]}`,
    declined: `Seu pagamento não foi aprovado. ${NOT_CHARGED["pt-BR"]}`,
    review: (s) => `Estamos confirmando seu pagamento com o PayPal. Você não pagará mais do que ${s}.`,
    pending: `Seu pagamento ainda não foi aprovado. ${NOT_CHARGED["pt-BR"]}`,
  },
  es: {
    fairPrice: (a, c) => `Tu precio es ${a}, el precio justo para tu país: ${c}.`,
    countryPrice: (a, c) => `Tu precio es ${a}, el precio para tu país: ${c}.`,
    standardPrice: (a) => `Tu precio es ${a}, el precio estándar.`,
    fairPriceNote: "Los precios justos requieren una cuenta de PayPal; los pagos con tarjeta pagan el precio estándar.",
    promise:
      "Antes de cobrar cualquier dinero, PayPal confirma el país de tu cuenta, y nunca se te cobrará más del precio que apruebes.",
    paid: (a, c) => (c ? `Pagaste ${a}, el precio justo para tu país: ${c}.` : `Pagaste ${a}.`),
    paidUnclear: (a) => `No pudimos confirmar tu país, así que se aplicó el precio estándar. Pagaste ${a}.`,
    paidCard: (a) => `Pagaste ${a}, el precio estándar para pagos con tarjeta.`,
    traveler: (charged, shown) => `Se te cobró ${charged}, el precio justo para tu país, no ${shown}.`,
    mismatch: (c, o) => `El país registrado en tu cuenta de PayPal es ${c}. El precio allí es ${o}. ${NOT_CHARGED.es}`,
    cardVoided: (o) =>
      `Los precios justos requieren una cuenta de PayPal, así que los pagos con tarjeta pagan el precio estándar de ${o}. ${NOT_CHARGED.es}`,
    unclearVoided: (o) => `No pudimos confirmar tu país, así que se aplica el precio estándar de ${o}. ${NOT_CHARGED.es}`,
    declined: `Tu pago no fue aprobado. ${NOT_CHARGED.es}`,
    review: (s) => `Estamos confirmando tu pago con PayPal. No se te cobrará más de ${s}.`,
    pending: `Tu pago aún no ha sido aprobado. ${NOT_CHARGED.es}`,
  },
};

const EN_FAIR_PRICE_NOTE = "Fair prices need a PayPal account; card payments pay the standard price.";
const EN_PROMISE =
  "Before any money is taken, PayPal confirms your account's country, and you're never charged more than the price you approve.";

/** The price explanation: the price and what it is, the card note if shown, and PayPal's promise. */
export function priceSpeech(lang: VoiceLanguage, q: PriceSpeechInput): string {
  const amount = spokenAmount(lang, q.priceCents);
  const country = q.shownCountry ? countryIn(lang, q.shownCountry) : null;
  if (lang === "en") {
    const first =
      country && q.inTable
        ? `Your price is ${amount}, the fair price for ${country}.`
        : country
          ? `Your price is ${amount}, the price for ${country}.`
          : `Your price is ${amount}, the standard price.`;
    return [first, q.fairPriceNote ? EN_FAIR_PRICE_NOTE : null, EN_PROMISE].filter(Boolean).join(" ");
  }
  const p = PHRASES[lang];
  const first = country && q.inTable ? p.fairPrice(amount, country) : country ? p.countryPrice(amount, country) : p.standardPrice(amount);
  return [first, q.fairPriceNote ? p.fairPriceNote : null, p.promise].filter(Boolean).join(" ");
}

/** The checkout result in the language. English is the page's own message, word for word. */
export function resultSpeech(lang: VoiceLanguage, r: CheckoutResult): string {
  if (lang === "en") return r.message;
  const p = PHRASES[lang];
  const amount = (cents: number | null) => spokenAmount(lang, cents ?? 0);
  const country = r.country ? countryIn(lang, r.country) : null;
  switch (r.result) {
    case "PAID":
      if (r.decision === "UNCLEAR") return p.paidUnclear(amount(r.chargedCents));
      if (r.decision === "NOT_PAYPAL") return p.paidCard(amount(r.chargedCents));
      return p.paid(amount(r.chargedCents), country);
    case "TRAVELER":
      return p.traveler(amount(r.chargedCents), amount(r.shownCents));
    case "MISMATCH":
      return country ? p.mismatch(country, amount(r.offerCents)) : p.unclearVoided(amount(r.offerCents));
    case "NOT_PAYPAL":
      return p.cardVoided(amount(r.offerCents));
    case "UNCLEAR":
      return p.unclearVoided(amount(r.offerCents));
    case "DECLINED":
      return p.declined;
    case "REVIEW":
      return p.review(amount(r.shownCents));
    case "PENDING":
      return p.pending;
  }
}
