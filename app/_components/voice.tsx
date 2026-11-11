"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import type { CheckoutResult } from "@/lib/checkout/messages";
import {
  LANGUAGE_INFO,
  priceSpeech,
  resultSpeech,
  VOICE_LANGUAGES,
  VOICE_UI,
  type PriceSpeechInput,
  type VoiceLanguage,
} from "@/lib/checkout/voice";
import { cx } from "./cx";

/**
 * Native-language help on the buyer page: a language picker, the explanation as text in that
 * language, and a Listen button that reads it with the browser's built-in voice (Web Speech API).
 * The sentences are fixed translations from lib/checkout/voice.ts, and the amounts come from the
 * server. Nothing here touches checkout. Speech only starts when the buyer presses Listen; if the
 * device has no voice for the language, the text still shows.
 */

type VoiceState = { lang: VoiceLanguage; setLang: (lang: VoiceLanguage) => void; price: PriceSpeechInput };
const VoiceContext = createContext<VoiceState | null>(null);

export function VoiceProvider({
  initialLang,
  price,
  children,
}: {
  initialLang: VoiceLanguage;
  price: PriceSpeechInput;
  children: ReactNode;
}) {
  const [lang, setLangState] = useState<VoiceLanguage>(initialLang);
  const setLang = useCallback((next: VoiceLanguage) => {
    stopSpeaking();
    setLangState(next);
  }, []);
  const value = useMemo(() => ({ lang, setLang, price }), [lang, setLang, price]);
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

/** Under the price: pick a language, read the explanation, listen to it. */
export function PriceVoice() {
  const voice = useContext(VoiceContext);
  const selectId = useId();
  if (!voice) return null;
  const { lang, setLang, price } = voice;
  const text = priceSpeech(lang, price);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line px-3 py-3" data-testid="price-voice">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={selectId} className="flex items-center gap-1.5 text-xs font-medium text-ink-2">
          <GlobeIcon />
          <span className="sr-only sm:not-sr-only">Language</span>
        </label>
        <select
          id={selectId}
          value={lang}
          onChange={(e) => setLang(e.target.value as VoiceLanguage)}
          className="h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-2 text-sm text-ink focus:border-accent focus:outline-2 focus:outline-accent/30 sm:flex-none"
        >
          {VOICE_LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {LANGUAGE_INFO[l].label}
            </option>
          ))}
        </select>
        <ListenButton key={lang} lang={lang} text={text} className="ml-auto" />
      </div>
      {lang !== "en" && (
        <p lang={LANGUAGE_INFO[lang].speechLang} className="text-sm leading-relaxed text-ink">
          {text}
        </p>
      )}
    </div>
  );
}

/** Inside the result card: the result in the chosen language, with Listen. */
export function ResultVoice({ result }: { result: CheckoutResult }) {
  const voice = useContext(VoiceContext);
  if (!voice) return null; // e.g. /checkout/return, which has no product page around it
  const { lang } = voice;
  const text = resultSpeech(lang, result);
  return (
    <div className="flex flex-col items-start gap-2" data-testid="result-voice">
      {lang !== "en" && (
        <p lang={LANGUAGE_INFO[lang].speechLang} className="text-sm leading-relaxed text-ink">
          {text}
        </p>
      )}
      <ListenButton key={lang} lang={lang} text={text} />
    </div>
  );
}

function ListenButton({ lang, text, className }: { lang: VoiceLanguage; text: string; className?: string }) {
  const supported = useSyncExternalStore(noSubscribe, speechSupported, () => false);
  const [speaking, setSpeaking] = useState(false);
  const [noVoiceFor, setNoVoiceFor] = useState<VoiceLanguage | null>(null);
  const ui = VOICE_UI[lang];

  // Stop speaking when this button goes away (it is re-created whenever the language changes).
  useEffect(() => () => stopSpeaking(), []);

  if (!supported) return null;

  const onClick = async () => {
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
      return;
    }
    const voiceForLang = await findVoice(lang);
    if (!voiceForLang) {
      setNoVoiceFor(lang);
      return;
    }
    setNoVoiceFor(null);
    setSpeaking(true);
    speak(text, lang, voiceForLang, () => setSpeaking(false));
  };

  return (
    <>
      <button
        type="button"
        onClick={() => void onClick()}
        aria-pressed={speaking}
        lang={LANGUAGE_INFO[lang].speechLang}
        className={cx(
          "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-medium text-ink",
          "transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          speaking && "border-accent text-accent-strong",
          className,
        )}
      >
        <SpeakerIcon active={speaking} />
        {speaking ? ui.stop : ui.listen}
      </button>
      {noVoiceFor === lang && (
        <p role="status" lang={LANGUAGE_INFO[lang].speechLang} className="basis-full text-xs text-ink-3">
          {ui.noVoice}
        </p>
      )}
    </>
  );
}

// ---- Web Speech API helpers (browser only) ----

const noSubscribe = () => () => {};
const speechSupported = () => typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;

function stopSpeaking() {
  if (speechSupported()) window.speechSynthesis.cancel();
}

/** The best installed voice for the language; voices can load late, so wait briefly for them. */
async function findVoice(lang: VoiceLanguage): Promise<SpeechSynthesisVoice | null> {
  const synth = window.speechSynthesis;
  let voices = synth.getVoices();
  if (voices.length === 0) {
    voices = await new Promise<SpeechSynthesisVoice[]>((resolve) => {
      const done = () => resolve(synth.getVoices());
      synth.addEventListener("voiceschanged", done, { once: true });
      setTimeout(done, 1500);
    });
  }
  for (const prefix of LANGUAGE_INFO[lang].voicePrefixes) {
    const match = voices.find((v) => v.lang.toLowerCase().replace("_", "-").startsWith(prefix));
    if (match) return match;
  }
  return null;
}

/** Read the text sentence by sentence (some browsers cut off long single utterances). */
function speak(text: string, lang: VoiceLanguage, voice: SpeechSynthesisVoice, onDone: () => void) {
  const synth = window.speechSynthesis;
  synth.cancel();
  const sentences = text.split(/(?<=[.!?।])\s+/).filter(Boolean);
  sentences.forEach((sentence, i) => {
    const utterance = new SpeechSynthesisUtterance(sentence);
    utterance.lang = LANGUAGE_INFO[lang].speechLang;
    utterance.voice = voice;
    utterance.rate = 0.95;
    if (i === sentences.length - 1) utterance.onend = onDone;
    utterance.onerror = onDone;
    synth.speak(utterance);
  });
}

function SpeakerIcon({ active }: { active: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8v4h3l4 3.5V4.5L6 8H3z" fill="currentColor" stroke="none" />
      <path d="M13 7.5a3.5 3.5 0 0 1 0 5" />
      {active && <path d="M15.5 5a7 7 0 0 1 0 10" />}
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10" cy="10" r="7.25" />
      <path d="M2.75 10h14.5M10 2.75c2 2.1 2.9 4.5 2.9 7.25S12 15.15 10 17.25C8 15.15 7.1 12.75 7.1 10S8 4.85 10 2.75z" />
    </svg>
  );
}
