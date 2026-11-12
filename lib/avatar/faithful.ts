/**
 * Did the avatar say only numbers FairPrice gave it? Every number in what it said (its own
 * transcript, which may spell numbers out) must appear in the allowed text. Pure: no I/O.
 *
 * Only that direction is checked: a transcript often arrives a word short, so a missing number is
 * normal, but an extra or changed number ("fifteen dollars" for 16) is not.
 * ponytail: numbers only; a reworded sentence with the same numbers passes.
 */
import { numbersIn } from "./numbers.mjs";

export { numbersIn };

/** True when the transcript states no number that the source text doesn't contain. */
export function saidOnlyGivenNumbers(source: string, transcript: string): boolean {
  const allowed = new Set(numbersIn(source));
  return numbersIn(transcript).every((n: string) => allowed.has(n));
}
