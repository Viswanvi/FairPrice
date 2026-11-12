/**
 * Numbers in a sentence, for the avatar's faithfulness check. Shared by the Alex bridge
 * (lib/alex/bridge.mjs, plain JS) and lib/avatar/faithful.ts (tested), so the rule is in one place.
 *
 * Gemini's transcript often spells numbers out ("sixteen dollars", "one hundred twenty"), so
 * English number words are turned into digits first; Devanagari digits and "1,200" are normalised.
 * A lone "one" stays a word (no FairPrice price is $1; minimum prices start higher).
 * ponytail: English words only; Hindi transcripts so far use digits. Add Hindi words (सोलह…) if
 * they start showing up.
 */

const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { hundred: 100, thousand: 1000 };
const WORD = new RegExp(`\\b(${[...Object.keys(SMALL), ...Object.keys(TENS), ...Object.keys(SCALES)].join("|")})\\b`, "i");

/** "one hundred twenty" → "120", "thirty-nine" → "39"; other words untouched. */
export function wordsToDigits(text) {
  const tokens = String(text).split(/(\s+|-)/);
  const out = [];
  let total = 0;
  let current = 0;
  let inNumber = false;
  let words = []; // the raw tokens of the number being read
  const flush = () => {
    // A lone "one" is nearly always a pronoun ("this one", "a one-line reason"), not a price.
    if (inNumber) out.push(words.length === 1 && /^one$/i.test(words[0].replace(/[^A-Za-z]/g, "")) ? words[0] : String(total + current));
    total = 0;
    current = 0;
    inNumber = false;
    words = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i];
    const w = raw.toLowerCase().replace(/[^a-z]/g, "");
    const trailing = raw.match(/[^A-Za-z]+$/)?.[0] ?? "";
    if (WORD.test(w) && w in { ...SMALL, ...TENS, ...SCALES }) {
      if (w in SMALL) current += SMALL[w];
      else if (w in TENS) current += TENS[w];
      else if (w === "hundred") current = (current || 1) * 100;
      else {
        total += (current || 1) * 1000;
        current = 0;
      }
      inNumber = true;
      words.push(trailing ? raw.slice(0, -trailing.length) : raw);
      if (trailing) {
        flush();
        out.push(trailing);
      }
      continue;
    }
    if (inNumber && (/^(\s+|-)$/.test(raw) || w === "and")) continue; // "one hundred and twenty"
    flush();
    out.push(raw);
  }
  flush();
  return out.join("").replace(/(\d)(?=[A-Za-z])/g, "$1 ");
}

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

/** Every number in the text, as digits ("sixteen" → "16", "१६" → "16", "1,200" → "1200"). */
export function numbersIn(text) {
  const ascii = wordsToDigits(text).replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
  return (ascii.match(/\d[\d,]*(\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, ""));
}
