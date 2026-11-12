import { findVoice, speak, stopSpeaking } from "../speech";

/**
 * The browser's own voice, used when Alex isn't available (no connection to Gemini, or the
 * visitor chose voice without Alex). Speaks only the text it's given.
 */
export interface SpeechAdapter {
  speak(text: string, lang: string): Promise<"done" | "failed">;
  stop(): void;
}

const VOICE_PREFIXES: Record<string, readonly string[]> = { en: ["en-in", "en-us", "en-gb", "en"], hi: ["hi"] };
const SPEECH_LANG: Record<string, string> = { en: "en-IN", hi: "hi-IN" };

/**
 * Alex is a man, so the browser voice should sound like one too (default voices are often
 * female). Matched by the voice's name: Windows and Chrome don't report a gender.
 * ponytail: a name list; extend it when a new platform voice shows up.
 */
const MALE_VOICE = /\b(male|david|mark|guy|ravi|prabhat|hemant|madhur|george|james|richard|ryan|christopher|daniel|alex|fred|rishi)\b/i;
const norm = (lang: string) => lang.toLowerCase().replace("_", "-");

/** A male voice in the language if the device has one (in prefix order), else any voice in it. */
async function guideVoice(prefixes: readonly string[]): Promise<SpeechSynthesisVoice | null> {
  const any = await findVoice(prefixes); // also waits for the voice list to load
  if (!any) return null;
  const voices = window.speechSynthesis.getVoices();
  for (const p of prefixes) {
    const male = voices.find((v) => norm(v.lang).startsWith(p) && MALE_VOICE.test(v.name) && !/female/i.test(v.name));
    if (male) return male;
  }
  return any;
}

/** Resolves "failed" when there is no voice for the language (the text on screen is the fallback). */
export function createVoiceAdapter(): SpeechAdapter {
  return {
    async speak(text, lang) {
      const voice = await guideVoice(VOICE_PREFIXES[lang] ?? [lang.toLowerCase(), lang.toLowerCase().split("-")[0]]);
      if (!voice) return "failed";
      return new Promise((resolve) => speak(text, SPEECH_LANG[lang] ?? lang, voice, () => resolve("done")));
    },
    stop: stopSpeaking,
  };
}
