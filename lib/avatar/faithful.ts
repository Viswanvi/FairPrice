/**
 * Did the avatar say only what FairPrice gave it? Gemini reports a transcript of what it spoke;
 * every number in it must appear in the text we sent. Pure: no I/O.
 *
 * Only that direction is checked: the transcript often arrives a word short at the end, so a
 * missing number is normal, but an extra or changed number ("15 dollars" for 16) is not.
 * ponytail: numbers only; a reworded sentence with the same numbers passes. Upgrade to a
 * word-overlap score if that turns out to matter.
 */

const DEVANAGARI_DIGITS = "०१२३४५६७८९";

/** Every number in the text, digits normalised (Devanagari → ASCII, "1,200" → "1200"). */
export function numbersIn(text: string): string[] {
  const ascii = text.replace(/[०-९]/g, (d) => String(DEVANAGARI_DIGITS.indexOf(d)));
  return (ascii.match(/\d[\d,]*(\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, ""));
}

/** True when the transcript states no number that the source text doesn't contain. */
export function saidOnlyGivenNumbers(source: string, transcript: string): boolean {
  const allowed = new Set(numbersIn(source));
  return numbersIn(transcript).every((n) => allowed.has(n));
}
