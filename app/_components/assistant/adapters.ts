import { findVoice, speak, stopSpeaking } from "../speech";
import { avatarSpeak, avatarStop, type SpeakOutcome } from "./avatar";

/**
 * How the guide speaks (AVATAR_SPEC section 7). The widget picks one adapter per turn:
 * AvatarAdapter on a fast connection while the video budget lasts, else VoiceAdapter (the
 * browser's own voice). Both only ever speak the text they're given.
 */
export interface SpeechAdapter {
  readonly kind: "video" | "voice";
  /** Get ready for a conversation in this language (nothing streams until speak()). */
  start(lang: string): void;
  /** Speak the text; resolves when it has finished (or was stopped, or failed). */
  speak(text: string, lang: string): Promise<SpeakOutcome>;
  /** Stop speaking now. */
  stop(): void;
  /** The conversation is over: release everything. */
  end(): void;
  /** Called with a short code when speaking fails (no text, no personal data). */
  onError?: (code: string) => void;
}

const VOICE_PREFIXES: Record<string, readonly string[]> = { en: ["en-in", "en-us", "en-gb", "en"], hi: ["hi"] };
const SPEECH_LANG: Record<string, string> = { en: "en-IN", hi: "hi-IN" };

/**
 * The avatar is a man, so when the guide falls back to the browser voice it should sound like
 * one too (default voices are often female). Matched by the voice's name: Windows and Chrome
 * don't report a gender. ponytail: a name list; extend it when a new platform voice shows up.
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

/** The browser's built-in voice. Resolves "failed" when there is no voice for the language (text only). */
export function createVoiceAdapter(): SpeechAdapter {
  const adapter: SpeechAdapter = {
    kind: "voice",
    start() {},
    async speak(text, lang) {
      const voice = await guideVoice(VOICE_PREFIXES[lang] ?? [lang.toLowerCase(), lang.toLowerCase().split("-")[0]]);
      if (!voice) {
        adapter.onError?.("no_voice");
        return "failed";
      }
      return new Promise<SpeakOutcome>((resolve) => speak(text, SPEECH_LANG[lang] ?? lang, voice, () => resolve("done")));
    },
    stop: stopSpeaking,
    end: stopSpeaking,
  };
  return adapter;
}

/** The video avatar (Gemini Live via POST /api/avatar/speak). */
export function createAvatarAdapter(): SpeechAdapter {
  const adapter: SpeechAdapter = {
    kind: "video",
    start() {},
    async speak(text) {
      const outcome = await avatarSpeak(text);
      if (outcome === "failed" || outcome === "unfaithful") adapter.onError?.(outcome);
      return outcome;
    },
    stop: avatarStop,
    end: avatarStop,
  };
  return adapter;
}
