import { countryPhrase } from "./messages";

/**
 * Buyer-page wording for the shown price (SPEC section 3 / 10). One plain sentence, no formulas;
 * the PayPal account country is what's verified, so the IP country is only "your country" here.
 */
export function priceHeadline(q: { shownCountry: string | null; inTable: boolean; priceCents: number; standardCents: number }): {
  label: string;
  /** Show the standard price as a small secondary line. */
  showStandard: boolean;
} {
  if (q.shownCountry && q.inTable) {
    return {
      label: `Fair price for ${countryPhrase(q.shownCountry)}, verified by PayPal at checkout`,
      showStandard: q.priceCents < q.standardCents,
    };
  }
  if (q.shownCountry) return { label: `Price for ${countryPhrase(q.shownCountry)}`, showStandard: false };
  return { label: "Standard price. PayPal confirms your country at checkout.", showStandard: false };
}

/** The slim banner shown while the demo ?as= override is active. */
export function demoBannerText(country: string): string {
  return `Demo: simulating a visitor from ${countryPhrase(country)}.`;
}
