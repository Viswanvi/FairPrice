"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AssistantLang, AssistantResponse, ProductCard } from "@/lib/assistant/schema";
import { MAX_TURN_CHARS, MAX_TURNS } from "@/lib/assistant/schema";
import type { CheckoutResult } from "@/lib/checkout/messages";
import { resultSpeech } from "@/lib/checkout/voice";
import { cx } from "../cx";
import {
  createRecognition,
  findVoice,
  noSubscribe,
  recognitionSupported,
  speak,
  speechSupported,
  stopSpeaking,
  type RecognitionLike,
} from "../speech";
import { CHECKOUT_RESULT_EVENT } from "./events";
import { performActions } from "./page-actions";

/**
 * The FairPrice voice assistant: a small floating panel on every page. Visitors talk (or type)
 * in English or Hindi; the server (POST /api/assistant) works out what they want and returns a
 * reply plus page actions, which run here. Speech uses the browser's own engines: in Chrome,
 * listening is Google's speech recognition. Nothing starts until the visitor taps (browsers
 * require it for the microphone and for sound).
 */

type Turn = { role: "user" | "assistant"; text: string; products?: ProductCard[] };
type Status = "idle" | "listening" | "thinking" | "speaking";

const STORAGE_KEY = "fp_assistant_v1";
export const WELCOME_KEY = "fp_assistant_welcome_seen";

const LISTEN_LANG: Record<AssistantLang, string> = { en: "en-IN", hi: "hi-IN" };
const VOICE_PREFIXES: Record<AssistantLang, readonly string[]> = { en: ["en-in", "en-us", "en-gb", "en"], hi: ["hi"] };
const SPEAK_LANG: Record<AssistantLang, string> = { en: "en-IN", hi: "hi-IN" };

const UI = {
  en: {
    title: "FairPrice assistant",
    tap: "Tap to speak",
    listening: "Listening…",
    thinking: "Working on it…",
    speaking: "Speaking · tap to stop",
    placeholder: "Or type here…",
    send: "Send",
    close: "Close assistant",
    open: "Open",
    fair: "fair price for",
    standard: "standard price",
    greeting: "Hi! I'm the FairPrice assistant. Do you want to buy something, or sell your own product?",
    filler: "One moment.",
    blocked: "The microphone is blocked. Allow it from the icon in the address bar, or type below.",
    noSpeech: "I didn't hear anything. Tap the mic and try again.",
    noRecognition: "Talking works in Chrome or Edge. You can type here instead.",
    error: "Something went wrong. Please try again.",
    couldNot: "I couldn't do that step on this page. Please check the page and try again.",
  },
  hi: {
    title: "FairPrice असिस्टेंट",
    tap: "बोलने के लिए टैप करें",
    listening: "सुन रहा हूँ…",
    thinking: "काम कर रहा हूँ…",
    speaking: "बोल रहा हूँ · रोकने के लिए टैप करें",
    placeholder: "या यहाँ लिखें…",
    send: "भेजें",
    close: "असिस्टेंट बंद करें",
    open: "खोलें",
    fair: "उचित कीमत:",
    standard: "मानक कीमत",
    greeting: "नमस्ते! मैं FairPrice असिस्टेंट हूँ। आप कुछ खरीदना चाहते हैं, या अपना प्रोडक्ट बेचना चाहते हैं?",
    filler: "एक पल।",
    blocked: "माइक्रोफ़ोन बंद है। एड्रेस बार के आइकन से इसे चालू करें, या नीचे लिखें।",
    noSpeech: "मुझे कुछ सुनाई नहीं दिया। माइक दबाकर फिर से बोलें।",
    noRecognition: "आवाज़ से बात Chrome या Edge में होती है। आप यहाँ लिख सकते हैं।",
    error: "कुछ गड़बड़ हुई। कृपया फिर से कोशिश करें।",
    couldNot: "मैं इस पेज पर वह कदम नहीं कर पाया। कृपया पेज देखकर फिर से कोशिश करें।",
  },
} satisfies Record<AssistantLang, Record<string, string>>;

type Saved = { open: boolean; lang: AssistantLang; turns: Turn[] };

function load(): Saved | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

function welcomeSeen(): boolean {
  try {
    return sessionStorage.getItem(WELCOME_KEY) === "1";
  } catch {
    return true;
  }
}

function markWelcomeSeen(): void {
  try {
    sessionStorage.setItem(WELCOME_KEY, "1");
  } catch {
    /* private mode: the welcome simply shows again next time */
  }
}

/** Hindi first for Hindi-language browsers or the India demo; otherwise English. */
function suggestedLang(): AssistantLang {
  if (typeof window === "undefined") return "en";
  if (navigator.languages?.some((l) => l.toLowerCase().startsWith("hi"))) return "hi";
  if (new URLSearchParams(window.location.search).get("as")?.toUpperCase() === "IN") return "hi";
  return "en";
}

/** The request body: the last turns, starting and ending with the visitor. */
function conversationFor(turns: Turn[]) {
  const recent = turns.slice(-MAX_TURNS).map((t) => ({ role: t.role, text: t.text.slice(0, MAX_TURN_CHARS) }));
  while (recent.length > 0 && recent[0].role !== "user") recent.shift();
  return recent;
}

export function Assistant() {
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const router = useRouter();
  const saved = useState(() => (typeof window === "undefined" ? null : load()))[0];
  const [open, setOpen] = useState(saved?.open ?? false);
  const [welcome, setWelcome] = useState(() => typeof window !== "undefined" && !welcomeSeen() && !saved?.open);
  const [lang, setLang] = useState<AssistantLang>(saved?.lang ?? "en");
  const [turns, setTurns] = useState<Turn[]>(saved?.turns ?? []);
  const [status, setStatus] = useState<Status>("idle");
  const [interim, setInterim] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const recognitionRef = useRef<RecognitionLike | null>(null);
  const handsFreeRef = useRef(false);
  const langRef = useRef(lang);
  const turnsRef = useRef(turns);
  const activeRef = useRef(turns.length > 0);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    langRef.current = lang;
    turnsRef.current = turns;
    activeRef.current = activeRef.current || turns.length > 0;
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ open, lang, turns: turns.slice(-MAX_TURNS) } satisfies Saved));
    } catch {
      /* storage unavailable: the conversation just won't survive a reload */
    }
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [open, lang, turns]);

  // Warm up the voice list so the first reply speaks without delay.
  useEffect(() => {
    if (speechSupported()) window.speechSynthesis.getVoices();
    return () => {
      recognitionRef.current?.abort();
      stopSpeaking();
    };
  }, []);

  const say = useCallback(async (text: string, l: AssistantLang, onDone: () => void) => {
    const voice = await findVoice(VOICE_PREFIXES[l]);
    if (!voice) {
      onDone();
      return;
    }
    speak(text, SPEAK_LANG[l], voice, onDone);
  }, []);

  const listenRef = useRef<() => void>(() => {});

  const afterSpeaking = useCallback(() => {
    setStatus("idle");
    if (handsFreeRef.current) listenRef.current();
  }, []);

  const send = useCallback(
    async (text: string, viaVoice: boolean) => {
      const l = langRef.current;
      const next: Turn[] = [...turnsRef.current, { role: "user", text }];
      turnsRef.current = next;
      setTurns(next);
      setStatus("thinking");
      setNote(null);
      const filler = viaVoice ? setTimeout(() => void say(UI[l].filler, l, () => {}), 1200) : null;

      let data: (AssistantResponse & { message?: string }) | null = null;
      let ok = false;
      try {
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lang: l,
            messages: conversationFor(next),
            path: window.location.pathname + window.location.search,
          }),
        });
        ok = res.ok;
        data = (await res.json()) as AssistantResponse & { message?: string };
      } catch {
        data = null;
      }
      if (filler) clearTimeout(filler);
      stopSpeaking();

      if (!ok || !data || typeof data.reply !== "string") {
        const message = data?.message ?? UI[l].error;
        setTurns((t) => [...t, { role: "assistant", text: message }]);
        setStatus("speaking");
        void say(message, l, () => setStatus("idle"));
        handsFreeRef.current = false;
        return;
      }

      const reply = data;
      setLang(reply.lang);
      langRef.current = reply.lang;
      setTurns((t) => [...t, { role: "assistant", text: reply.reply, products: reply.products.length ? reply.products : undefined }]);
      setStatus("speaking");
      void say(reply.reply, reply.lang, afterSpeaking);
      const problems = await performActions(reply.actions, router);
      if (problems.length > 0) setNote(UI[reply.lang].couldNot);
    },
    [router, say, afterSpeaking],
  );

  const startListening = useCallback(() => {
    const l = langRef.current;
    if (!recognitionSupported()) {
      setNote(UI[l].noRecognition);
      handsFreeRef.current = false;
      return;
    }
    stopSpeaking();
    recognitionRef.current?.abort();
    const recognition = createRecognition(LISTEN_LANG[l]);
    if (!recognition) return;
    recognitionRef.current = recognition;
    let finalText = "";

    recognition.onresult = (event) => {
      let live = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else live += result[0].transcript;
      }
      setInterim((finalText + " " + live).trim());
    };
    recognition.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setNote(UI[l].blocked);
        handsFreeRef.current = false;
      } else if (event.error === "no-speech") {
        setNote(UI[l].noSpeech);
        handsFreeRef.current = false;
      }
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setInterim("");
      const heard = finalText.trim();
      if (heard) void send(heard, true);
      else setStatus((s) => (s === "listening" ? "idle" : s));
    };

    setNote(null);
    setStatus("listening");
    handsFreeRef.current = true;
    try {
      recognition.start();
    } catch {
      setStatus("idle");
    }
  }, [send]);

  useEffect(() => {
    listenRef.current = startListening;
  }, [startListening]);

  // Read the payment result aloud when the visitor has been using the assistant.
  useEffect(() => {
    const onResult = (event: Event) => {
      if (!activeRef.current) return;
      const l = langRef.current;
      const text = resultSpeech(l, (event as CustomEvent<CheckoutResult>).detail);
      setTurns((t) => [...t, { role: "assistant", text }]);
      setStatus("speaking");
      handsFreeRef.current = false;
      void say(text, l, () => setStatus("idle"));
    };
    window.addEventListener(CHECKOUT_RESULT_EVENT, onResult);
    return () => window.removeEventListener(CHECKOUT_RESULT_EVENT, onResult);
  }, [say]);

  const begin = (l: AssistantLang) => {
    markWelcomeSeen();
    setWelcome(false);
    setOpen(true);
    setLang(l);
    langRef.current = l;
    activeRef.current = true;
    const greeting = UI[l].greeting;
    if (turnsRef.current.length === 0) setTurns([{ role: "assistant", text: greeting }]);
    setStatus("speaking");
    handsFreeRef.current = true; // after the greeting, start listening straight away
    void say(greeting, l, afterSpeaking);
  };

  const micPressed = () => {
    if (status === "listening") {
      handsFreeRef.current = false;
      recognitionRef.current?.stop();
      return;
    }
    if (status === "speaking") {
      handsFreeRef.current = false;
      stopSpeaking();
      setStatus("idle");
      return;
    }
    if (status === "thinking") return;
    activeRef.current = true;
    startListening();
  };

  const submitDraft = () => {
    const text = draft.trim();
    if (!text || status === "thinking") return;
    setDraft("");
    handsFreeRef.current = false;
    recognitionRef.current?.abort();
    stopSpeaking();
    activeRef.current = true;
    void send(text.slice(0, MAX_TURN_CHARS), false);
  };

  const close = () => {
    handsFreeRef.current = false;
    recognitionRef.current?.abort();
    stopSpeaking();
    setStatus("idle");
    setOpen(false);
  };

  if (!isClient) return null;
  const ui = UI[lang];

  return (
    <>
      {welcome && !open && (
        <section
          aria-label="FairPrice assistant"
          data-testid="assistant-welcome"
          className="fixed inset-x-3 bottom-3 z-50 flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[360px]"
        >
          <div className="flex items-start gap-3">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-ink">
              <MicIcon />
            </span>
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-semibold text-ink">Need a hand? · मदद चाहिए?</h2>
              <p className="text-xs leading-relaxed text-ink-2">
                I can find a product for you, or help you sell yours. Just talk.
                <span lang="hi" className="block">मैं आपके लिए प्रोडक्ट ढूँढ सकता हूँ या आपका प्रोडक्ट बेचने में मदद कर सकता हूँ।</span>
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {(suggestedLang() === "hi" ? (["hi", "en"] as const) : (["en", "hi"] as const)).map((l, i) => (
              <button
                key={l}
                type="button"
                onClick={() => begin(l)}
                lang={l}
                className={cx(
                  "inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                  i === 0 ? "bg-accent text-accent-ink hover:bg-accent-strong" : "border border-line-strong bg-surface text-ink hover:bg-surface-2",
                )}
              >
                <MicIcon />
                {l === "hi" ? "हिन्दी में बोलें" : "Talk in English"}
              </button>
            ))}
            <button
              type="button"
              onClick={() => {
                markWelcomeSeen();
                setWelcome(false);
              }}
              className="h-9 rounded-lg text-sm font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              Explore on my own · खुद देखें
            </button>
          </div>
        </section>
      )}

      {!open && !welcome && (
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            if (turnsRef.current.length === 0) setTurns([{ role: "assistant", text: UI[lang].greeting }]);
          }}
          aria-label="Open the FairPrice assistant"
          data-testid="assistant-launcher"
          className="fixed right-4 bottom-4 z-50 grid size-14 place-items-center rounded-full bg-accent text-accent-ink shadow-card transition-colors hover:bg-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <MicIcon large />
        </button>
      )}

      {open && (
        <section
          role="dialog"
          aria-label={ui.title}
          data-testid="assistant-panel"
          onKeyDown={(e) => e.key === "Escape" && close()}
          className="fixed inset-x-2 bottom-2 z-50 flex max-h-[min(560px,calc(100dvh-1rem))] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-card sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[380px]"
        >
          <header className="flex items-center gap-2 border-b border-line px-4 py-3">
            <span aria-hidden className="grid size-7 place-items-center rounded-full bg-accent text-accent-ink">
              <MicIcon />
            </span>
            <h2 className="flex-1 text-sm font-semibold text-ink">{ui.title}</h2>
            <div role="radiogroup" aria-label="Language" className="flex rounded-lg border border-line-strong p-0.5 text-xs">
              {(["en", "hi"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={lang === l}
                  onClick={() => {
                    recognitionRef.current?.abort();
                    stopSpeaking();
                    handsFreeRef.current = false;
                    setStatus("idle");
                    setLang(l);
                  }}
                  className={cx("rounded-md px-2 py-1 font-medium", lang === l ? "bg-accent text-accent-ink" : "text-ink-2 hover:text-ink")}
                >
                  {l === "en" ? "EN" : "हिं"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={close}
              aria-label={ui.close}
              className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <span aria-hidden>✕</span>
            </button>
          </header>

          <div ref={listRef} aria-live="polite" className="flex min-h-[120px] flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
            {turns.map((turn, i) => (
              <div key={i} className={cx("flex flex-col gap-2", turn.role === "user" ? "items-end" : "items-start")}>
                <p
                  lang={/[ऀ-ॿ]/.test(turn.text) ? "hi" : "en"}
                  className={cx(
                    "max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed",
                    turn.role === "user" ? "bg-accent text-accent-ink" : "bg-surface-2 text-ink",
                  )}
                >
                  {turn.text}
                </p>
                {turn.products?.map((p) => (
                  <div key={p.id} className="flex w-full max-w-[85%] items-center gap-3 rounded-xl border border-line px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm font-medium text-ink">{p.title}</p>
                      <p className="text-xs text-ink-2">
                        <span className="font-semibold text-ink tabular-nums">{p.priceText}</span> ·{" "}
                        {p.fairFor ? `${ui.fair} ${p.fairFor}` : ui.standard}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => router.push(p.path)}
                      className="h-8 shrink-0 rounded-lg border border-line-strong px-3 text-xs font-medium text-ink hover:bg-surface-2"
                    >
                      {ui.open}
                    </button>
                  </div>
                ))}
              </div>
            ))}
            {interim && (
              <p className="max-w-[85%] self-end rounded-2xl border border-dashed border-accent px-3 py-2 text-sm text-ink-2">{interim}</p>
            )}
            {status === "thinking" && (
              <p className="flex items-center gap-1 self-start rounded-2xl bg-surface-2 px-3 py-2" aria-label={ui.thinking}>
                <Dot delay="0ms" />
                <Dot delay="150ms" />
                <Dot delay="300ms" />
              </p>
            )}
          </div>

          {note && (
            <p role="status" className="mx-4 mb-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
              {note}
            </p>
          )}

          <footer className="flex flex-col gap-2 border-t border-line px-4 py-3">
            <button
              type="button"
              onClick={micPressed}
              aria-pressed={status === "listening"}
              disabled={status === "thinking"}
              className={cx(
                "inline-flex h-11 items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60",
                status === "listening" ? "bg-danger text-white" : "bg-accent text-accent-ink hover:bg-accent-strong",
              )}
            >
              <MicIcon />
              {status === "listening" ? ui.listening : status === "thinking" ? ui.thinking : status === "speaking" ? ui.speaking : ui.tap}
            </button>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submitDraft();
              }}
            >
              <label className="sr-only" htmlFor="assistant-input">
                {ui.placeholder}
              </label>
              <input
                id="assistant-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={MAX_TURN_CHARS}
                placeholder={ui.placeholder}
                autoComplete="off"
                className="h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-2 focus:outline-accent/30"
              />
              <button
                type="submit"
                disabled={!draft.trim() || status === "thinking"}
                className="h-9 rounded-lg border border-line-strong px-3 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
              >
                {ui.send}
              </button>
            </form>
          </footer>
        </section>
      )}
    </>
  );
}

function Dot({ delay }: { delay: string }) {
  return <span className="size-1.5 animate-bounce rounded-full bg-ink-3" style={{ animationDelay: delay }} />;
}

function MicIcon({ large = false }: { large?: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className={large ? "size-6" : "size-4"} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <rect x="7" y="2.5" width="6" height="10" rx="3" fill="currentColor" stroke="none" />
      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
    </svg>
  );
}
