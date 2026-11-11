/**
 * Browser speech helpers shared by the Listen buttons and the voice assistant.
 * - Speaking: the Web Speech API's speechSynthesis (voices built into the browser/OS).
 * - Listening: SpeechRecognition (in Chrome this is Google's speech recognition; Edge uses
 *   Microsoft's). Firefox has no recognition, so callers fall back to typing.
 * Browser only; every function checks support first.
 */

export const noSubscribe = () => () => {};

export const speechSupported = (): boolean =>
  typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}

/** The first installed voice whose language starts with one of the prefixes (in order); voices can load late. */
export async function findVoice(prefixes: readonly string[]): Promise<SpeechSynthesisVoice | null> {
  if (!speechSupported()) return null;
  const synth = window.speechSynthesis;
  let voices = synth.getVoices();
  if (voices.length === 0) {
    voices = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
      const done = () => resolve(synth.getVoices());
      synth.addEventListener("voiceschanged", done, { once: true });
      setTimeout(done, 1500);
    });
  }
  for (const prefix of prefixes) {
    const match = voices.find((v) => v.lang.toLowerCase().replace("_", "-").startsWith(prefix));
    if (match) return match;
  }
  return null;
}

/** Read text sentence by sentence (some browsers cut off long single utterances). */
export function speak(text: string, speechLang: string, voice: SpeechSynthesisVoice, onDone: () => void): void {
  const synth = window.speechSynthesis;
  synth.cancel();
  const sentences = text.split(/(?<=[.!?।])\s+/).filter(Boolean);
  if (sentences.length === 0) {
    onDone();
    return;
  }
  sentences.forEach((sentence, i) => {
    const utterance = new SpeechSynthesisUtterance(sentence);
    utterance.lang = speechLang;
    utterance.voice = voice;
    utterance.rate = 1;
    if (i === sentences.length - 1) utterance.onend = onDone;
    utterance.onerror = onDone;
    synth.speak(utterance);
  });
}

// ---- Speech recognition (not in TypeScript's DOM types yet) ----

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: RecognitionAlternative;
}
export interface RecognitionResultEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: RecognitionResult };
}
export interface RecognitionErrorEvent {
  readonly error: string;
}
export interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const recognitionSupported = (): boolean => recognitionCtor() !== null;

/** A one-utterance recognizer with live (interim) results. */
export function createRecognition(lang: string): RecognitionLike | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  const recognition = new Ctor();
  recognition.lang = lang;
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;
  return recognition;
}
