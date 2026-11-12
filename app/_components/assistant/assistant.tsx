"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AssistantLang, AssistantResponse, ProductCard } from "@/lib/assistant/schema";
import { MAX_TURN_CHARS, MAX_TURNS } from "@/lib/assistant/schema";
import { heardOwnLine, isTourRequest, TOUR, tourCommand, tourLang, type TourStep } from "@/lib/assistant/tour";
import type { CheckoutResult } from "@/lib/checkout/messages";
import { resultSpeech, VOICE_LANGUAGES, type VoiceLanguage } from "@/lib/checkout/voice";
import { cx } from "../cx";
import { createRecognition, noSubscribe, recognitionSupported, speechSupported, type RecognitionLike } from "../speech";
import { createAvatarAdapter, createVoiceAdapter } from "./adapters";
import {
  attachAvatarVideo,
  avatarStop,
  noteVideoFailure,
  startVideoTask,
  takeVideoTurn,
  turnVideoOff,
  videoAvailable,
  videoTurnsLeft,
  type SpeakOutcome,
} from "./avatar";
import { CHECKOUT_RESULT_EVENT } from "./events";
import { highlight, performActions } from "./page-actions";

/** One of each per page; the widget picks which speaks each turn. */
const avatarAdapter = createAvatarAdapter();
const voiceAdapter = createVoiceAdapter();

/** How the guide speaks, chosen by the visitor: video when possible (default), voice, or text only. */
type Output = "video" | "voice" | "text";
const OUTPUT_KEY = "fp_guide_output";

function loadOutput(): Output {
  try {
    const v = sessionStorage.getItem(OUTPUT_KEY);
    return v === "voice" || v === "text" ? v : "video";
  } catch {
    return "video";
  }
}

function saveOutput(o: Output): void {
  try {
    sessionStorage.setItem(OUTPUT_KEY, o);
  } catch {
    /* storage unavailable: the choice lasts until reload */
  }
}

/**
 * The FairPrice guide: a small floating panel on every page. Visitors talk (or type) in their
 * language; the server (POST /api/assistant) works out what they want and returns a reply plus
 * page actions, which run here. A guided tour (lib/assistant/tour.ts) walks through the product.
 *
 * Speaking: on a fast connection, a video avatar reads the text (./avatar.ts); otherwise, or once
 * the video budget is used, the browser's own voice; with no voice, the text on screen. The avatar
 * only ever reads text FairPrice already has. Listening is the browser's speech recognition.
 * Nothing starts until the visitor taps (browsers require it for the microphone and for sound).
 */

type Turn = { role: "user" | "assistant"; text: string; products?: ProductCard[] };
type Status = "idle" | "listening" | "thinking" | "speaking";

const STORAGE_KEY = "fp_assistant_v1";
export const WELCOME_KEY = "fp_assistant_welcome_seen";

/** Expected turns for a Talk task (AVATAR_SPEC section 6): seller setup 6, anything else 2. */
const talkTurns = (path: string) => (path.startsWith("/seller") ? 6 : 2);

const LISTEN_LANG: Record<string, string> = { en: "en-IN", hi: "hi-IN" };
const listenLang = (l: string) => LISTEN_LANG[l] ?? l;
/** Payment results have written translations for a few languages; others hear English. */
const resultLang = (l: string): VoiceLanguage => ((VOICE_LANGUAGES as readonly string[]).includes(l) ? (l as VoiceLanguage) : "en");

const UI_EN = {
  title: "FairPrice AI guide",
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
  greeting: "Hi! I'm the FairPrice AI guide. Do you want to buy something, or sell your own product?",
  filler: "One moment.",
  blocked: "The microphone is blocked. Allow it from the icon in the address bar, or type below.",
  noSpeech: "I didn't hear anything. Tap the mic and try again.",
  noRecognition: "Talking works in Chrome or Edge. You can type here instead.",
  error: "Something went wrong. Please try again.",
  couldNot: "I couldn't do that step on this page. Please check the page and try again.",
  switching: "Switching to voice to keep this quick.",
  videoOff: "Video isn't available right now, so I'll use my voice.",
  tour: "Tour",
  pause: "Pause",
  resume: "Resume",
  skip: "Skip",
  stop: "Stop tour",
  waiting: "Waiting for you… say “skip” to move on.",
  aiLabel: "AI guide · not a person",
  speakWith: "How the guide speaks",
  outVideo: "Video",
  outVoice: "Voice",
  outText: "Text",
};
type UiText = typeof UI_EN;

const UI: Record<string, UiText> = {
  en: UI_EN,
  hi: {
    title: "FairPrice AI गाइड",
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
    greeting: "नमस्ते! मैं FairPrice का AI गाइड हूँ। आप कुछ खरीदना चाहते हैं, या अपना प्रोडक्ट बेचना चाहते हैं?",
    filler: "एक पल।",
    blocked: "माइक्रोफ़ोन बंद है। एड्रेस बार के आइकन से इसे चालू करें, या नीचे लिखें।",
    noSpeech: "मुझे कुछ सुनाई नहीं दिया। माइक दबाकर फिर से बोलें।",
    noRecognition: "आवाज़ से बात Chrome या Edge में होती है। आप यहाँ लिख सकते हैं।",
    error: "कुछ गड़बड़ हुई। कृपया फिर से कोशिश करें।",
    couldNot: "मैं इस पेज पर वह कदम नहीं कर पाया। कृपया पेज देखकर फिर से कोशिश करें।",
    switching: "जल्दी के लिए अब मैं सिर्फ़ आवाज़ से बात करूँगा।",
    videoOff: "वीडियो अभी उपलब्ध नहीं है, इसलिए मैं आवाज़ से बात करूँगा।",
    tour: "टूर",
    pause: "रोकें",
    resume: "जारी रखें",
    skip: "स्किप",
    stop: "टूर बंद करें",
    waiting: "आपका इंतज़ार कर रहा हूँ… आगे बढ़ने के लिए “स्किप” बोलें।",
    aiLabel: "AI गाइड · इंसान नहीं",
    speakWith: "गाइड कैसे बोले",
    outVideo: "वीडियो",
    outVoice: "आवाज़",
    outText: "टेक्स्ट",
  },
};
const ui = (l: string): UiText => UI[l] ?? UI_EN;

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
function suggestedLang(): "en" | "hi" {
  if (typeof window === "undefined") return "en";
  if (navigator.languages?.some((l) => l.toLowerCase().startsWith("hi"))) return "hi";
  if (new URLSearchParams(window.location.search).get("as")?.toUpperCase() === "IN") return "hi";
  return "en";
}

/** The browser's own language when it isn't English or Hindi (offered as a third choice). */
function browserLang(): { code: string; label: string } | null {
  if (typeof navigator === "undefined") return null;
  const code = navigator.language || "";
  const base = code.split("-")[0].toLowerCase();
  if (!base || base === "en" || base === "hi") return null;
  try {
    const label = new Intl.DisplayNames([code], { type: "language" }).of(base) ?? base;
    return { code: base, label };
  } catch {
    return { code: base, label: base };
  }
}

/** The request body: the last turns, starting and ending with the visitor. */
function conversationFor(turns: Turn[]) {
  const recent = turns.slice(-MAX_TURNS).map((t) => ({ role: t.role, text: t.text.slice(0, MAX_TURN_CHARS) }));
  while (recent.length > 0 && recent[0].role !== "user") recent.shift();
  return recent;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves when `get` returns something, or null after the timeout or abort. */
async function waitUntil<T>(get: () => T | null, timeoutMs: number, signal?: AbortSignal): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) return null;
    const value = get();
    if (value) return value;
    if (Date.now() > end) return null;
    await sleep(150);
  }
}

const marker = (name: string) => document.querySelector<HTMLElement>(`[data-assistant-highlight="${name}"]`);

type TourState = { index: number; paused: boolean; waiting: boolean };
type StepEnd = "next" | "skip" | "stop" | "pause";

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
  const [video, setVideo] = useState(false);
  const [tour, setTour] = useState<TourState | null>(null);
  const [output, setOutput] = useState<Output>(() => (typeof window === "undefined" ? "video" : loadOutput()));

  const recognitionRef = useRef<RecognitionLike | null>(null);
  const handsFreeRef = useRef(false);
  const langRef = useRef(lang);
  const turnsRef = useRef(turns);
  const activeRef = useRef(turns.length > 0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef(false);
  const outputRef = useRef(output);
  const micBlockedRef = useRef(false);
  /** The latest beginTour, so send() can start the tour (send is memoised; beginTour is not). */
  const beginTourRef = useRef<(l: AssistantLang) => void>(() => {});
  const tourRef = useRef<{ token: number; step: AbortController | null; end: StepEnd | null; resume: (() => void) | null }>({
    token: 0,
    step: null,
    end: null,
    resume: null,
  });

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

  /** Stop all speech now: the avatar and the browser voice. */
  const hush = useCallback(() => {
    avatarAdapter.stop();
    voiceAdapter.stop();
  }, []);

  // Warm up the voice list so the first reply speaks without delay; stop the avatar when the
  // tab is hidden (spec: no streaming when no one is watching).
  useEffect(() => {
    if (speechSupported()) window.speechSynthesis.getVoices();
    // Only if it stays hidden: a permission bubble or a quick window switch can flicker "hidden"
    // for a moment, which used to cut the avatar off mid-sentence.
    const onHidden = () => {
      if (document.visibilityState !== "hidden") return;
      setTimeout(() => document.visibilityState === "hidden" && avatarStop(), 1500);
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      recognitionRef.current?.abort();
      avatarAdapter.end();
      voiceAdapter.end();
    };
  }, []);

  const setVideoMode = useCallback((on: boolean) => {
    videoRef.current = on;
    setVideo(on);
  }, []);

  /** Start a task: video for its expected turns plus two, if the connection is fast enough. */
  const startTask = useCallback(
    (expectedTurns: number) => {
      const on = outputRef.current === "video" && videoAvailable();
      if (on) startVideoTask(expectedTurns);
      setVideoMode(on);
    },
    [setVideoMode],
  );

  /** The visitor chose how the guide speaks (spec rule 7: switch to voice or text). */
  const chooseOutput = useCallback(
    (o: Output) => {
      hush();
      outputRef.current = o;
      setOutput(o);
      saveOutput(o);
      // Back to video only while this task's budget lasts; choosing it doesn't refill the budget.
      setVideoMode(o === "video" && videoAvailable() && videoTurnsLeft() > 0);
    },
    [hush, setVideoMode],
  );

  /**
   * Speak FairPrice's text through the adapter for this turn: the avatar in video mode (exact
   * text only), else the browser voice, else nothing (the text on screen). Reports how it ended.
   */
  const say = useCallback(
    async (text: string, l: AssistantLang, onDone: (outcome: SpeakOutcome) => void) => {
      if (outputRef.current === "text") return onDone("done");
      if (videoRef.current) {
        if (takeVideoTurn()) {
          const outcome = await avatarAdapter.speak(text, l);
          if (outcome === "done" || outcome === "stopped") return onDone(outcome);
          if (outcome === "unfaithful") {
            turnVideoOff(); // it said a number we didn't give it: voice for the rest of this visit
            setVideoMode(false);
            return onDone("done"); // it has already been heard; don't repeat it
          }
          // Failed: this turn uses voice; a second failure turns video off for the visit.
          if (noteVideoFailure()) {
            setVideoMode(false);
            setNote(ui(l).videoOff);
          }
        } else {
          setVideoMode(false);
          setNote(ui(l).switching);
        }
      }
      const outcome = await voiceAdapter.speak(text, l);
      onDone(outcome === "failed" ? "done" : outcome); // no voice for this language: the text on screen
    },
    [setVideoMode],
  );

  /** say() as a promise. */
  const sayP = useCallback(
    (text: string, l: AssistantLang) => new Promise<SpeakOutcome>((resolve) => void say(text, l, resolve)),
    [say],
  );

  const listenRef = useRef<() => void>(() => {});

  const afterSpeaking = useCallback(() => {
    setStatus("idle");
    if (handsFreeRef.current) listenRef.current();
  }, []);

  const send = useCallback(
    async (text: string, viaVoice: boolean) => {
      // "Walk me through the demo": run the guided tour rather than answer in chat.
      if (!tourRef.current.step && isTourRequest(text)) {
        setTurns((t) => [...t, { role: "user", text }]);
        beginTourRef.current(langRef.current);
        return;
      }
      const l = langRef.current;
      const next: Turn[] = [...turnsRef.current, { role: "user", text }];
      turnsRef.current = next;
      setTurns(next);
      setStatus("thinking");
      setNote(null);
      // A filler while the AI works; not in video mode, where it would cost a video turn.
      const filler =
        viaVoice && !videoRef.current && outputRef.current !== "text"
          ? setTimeout(() => void voiceAdapter.speak(ui(l).filler, l), 1200)
          : null;

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
      hush();

      if (!ok || !data || typeof data.reply !== "string") {
        const message = data?.message ?? ui(l).error;
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
      if (problems.length > 0) setNote(ui(reply.lang).couldNot);
    },
    [router, say, afterSpeaking, hush],
  );

  /** Listen once. `onHeard` replaces the normal "send to the assistant" (the tour uses it for skip/stop). */
  const startListening = useCallback(
    (onHeard?: (heard: string) => void) => {
      const l = langRef.current;
      if (!recognitionSupported()) {
        if (onHeard) return; // the tour still has its buttons and the text box
        setNote(ui(l).noRecognition);
        handsFreeRef.current = false;
        return;
      }
      if (!onHeard) hush(); // listening for tour commands doesn't interrupt the guide
      recognitionRef.current?.abort();
      const recognition = createRecognition(listenLang(l));
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
          setNote(ui(l).blocked);
          handsFreeRef.current = false;
          micBlockedRef.current = true; // the tour stops retrying
        } else if (event.error === "no-speech" && !onHeard) {
          setNote(ui(l).noSpeech);
          handsFreeRef.current = false;
        }
      };
      recognition.onend = () => {
        if (recognitionRef.current === recognition) recognitionRef.current = null;
        setInterim("");
        const heard = finalText.trim();
        if (onHeard) onHeard(heard);
        else if (heard) void send(heard, true);
        else setStatus((s) => (s === "listening" ? "idle" : s));
      };

      if (!onHeard) {
        setNote(null);
        setStatus("listening");
        handsFreeRef.current = true;
        micBlockedRef.current = false;
      }
      try {
        recognition.start();
      } catch {
        if (!onHeard) setStatus("idle");
      }
    },
    [send, hush],
  );

  useEffect(() => {
    listenRef.current = () => startListening();
  }, [startListening]);

  // Read the payment result aloud when the visitor has been using the assistant (the tour reads
  // it itself, in order).
  useEffect(() => {
    const onResult = (event: Event) => {
      if (!activeRef.current || tourRef.current.step) return;
      const l = langRef.current;
      const text = resultSpeech(resultLang(l), (event as CustomEvent<CheckoutResult>).detail);
      setTurns((t) => [...t, { role: "assistant", text }]);
      setStatus("speaking");
      handsFreeRef.current = false;
      void say(text, l, () => setStatus("idle"));
    };
    window.addEventListener(CHECKOUT_RESULT_EVENT, onResult);
    return () => window.removeEventListener(CHECKOUT_RESULT_EVENT, onResult);
  }, [say]);

  // ---- Tour ----

  /** End the current tour step early: skip it, stop the tour, or pause. */
  const endStep = useCallback(
    (end: StepEnd) => {
      const t = tourRef.current;
      if (!t.step) return;
      t.end = end;
      recognitionRef.current?.abort();
      hush();
      t.step.abort();
    },
    [hush],
  );

  /** Run one step; resolves with how it ended. */
  const runStep = useCallback(
    async (step: TourStep, l: AssistantLang, signal: AbortSignal): Promise<"next" | "notNeeded"> => {
      if (step.path) {
        if (step.onlyIfSignedOut) {
          // /seller sends signed-out visitors to /seller/sign-in; signed-in sellers stay on /seller.
          router.push(step.path);
          const where = await waitUntil(
            () => {
              const p = window.location.pathname;
              if (p === "/seller/sign-in") return marker("password_field") ? "signin" : null;
              return p === "/seller" ? "in" : null;
            },
            10_000,
            signal,
          );
          if (where !== "signin") return "notNeeded";
        } else {
          await performActions([{ type: "navigate", path: step.path }], router);
        }
      }
      for (const name of step.click ?? []) {
        const el = await waitUntil(() => marker(name), 8000, signal);
        if (el && !(el as HTMLButtonElement).disabled) {
          el.click();
          await sleep(400);
        }
      }
      if (step.highlight) {
        const el = await waitUntil(() => marker(step.highlight!), 8000, signal);
        if (el) highlight(el);
      }
      if (signal.aborted) return "next";

      // Listen for "skip" / "stop" for the whole step. While a line plays, a command word the line
      // itself says ("…or say skip") is ignored, so the guide can't skip itself through the speaker.
      let speakingLine: string | null = null;
      let stepDone = false;
      const listen = () => {
        if (stepDone || signal.aborted || micBlockedRef.current || !recognitionSupported()) return;
        startListening((heard) => {
          const cmd = tourCommand(heard);
          if (cmd && !heardOwnLine(cmd, speakingLine)) endStep(cmd);
          else setTimeout(listen, 300);
        });
      };
      /** Say a line; if the avatar stopped without anyone asking, say it with the browser voice. */
      const speakLine = async (text: string) => {
        speakingLine = text;
        setStatus("speaking");
        const outcome = await sayP(text, l);
        if (outcome === "stopped" && !signal.aborted && outputRef.current !== "text" && document.visibilityState === "visible") {
          await voiceAdapter.speak(text, l);
        }
        speakingLine = null;
        setStatus("idle");
      };

      try {
        listen();
        const line = step.line[tourLang(l)];
        setTurns((t) => [...t, { role: "assistant", text: line }]);
        await speakLine(line);
        if (signal.aborted || !step.wait) return "next";

        // Wait for the visitor: the payment result, or the seller signing in.
        setTour((s) => (s ? { ...s, waiting: true } : s));
        let result: CheckoutResult | null = null;
        const onResult = (e: Event) => (result = (e as CustomEvent<CheckoutResult>).detail);
        window.addEventListener(CHECKOUT_RESULT_EVENT, onResult);
        try {
          if (step.wait === "checkout_result") await waitUntil(() => result, 3 * 60_000, signal);
          else await waitUntil(() => (window.location.pathname === "/seller" && !marker("password_field") ? true : null), 5 * 60_000, signal);
        } finally {
          window.removeEventListener(CHECKOUT_RESULT_EVENT, onResult);
          setTour((s) => (s ? { ...s, waiting: false } : s));
        }
        if (result && !signal.aborted) {
          // The result card's own message, read as written (spec: the avatar adds nothing about payment).
          const text = resultSpeech(resultLang(l), result);
          setTurns((t) => [...t, { role: "assistant", text }]);
          await speakLine(text);
        }
        return "next";
      } finally {
        stepDone = true;
        recognitionRef.current?.abort();
      }
    },
    [router, sayP, startListening, endStep],
  );

  const runTour = useCallback(
    async (l: AssistantLang) => {
      const t = tourRef.current;
      const token = ++t.token;
      let i = 0;
      while (i < TOUR.length && t.token === token) {
        const step = TOUR[i];
        setTour({ index: i, paused: false, waiting: false });
        const ctl = new AbortController();
        t.step = ctl;
        t.end = null;
        await runStep(step, l, ctl.signal);
        t.step = null;
        if (t.token !== token) return;
        // Set by endStep() from a button or a voice command while the step ran.
        const end: StepEnd = (t.end as StepEnd | null) ?? "next";
        if (end === "stop") break;
        if (end === "pause") {
          setTour({ index: i, paused: true, waiting: false });
          await new Promise<void>((resolve) => (t.resume = resolve));
          t.resume = null;
          continue; // repeat the paused step from its start
        }
        // Skipping the seller sign-in skips the seller part (spec: T6 → T8).
        if (step.id === "T7" && end === "skip") {
          i = TOUR.findIndex((s) => s.id === "T8");
          continue;
        }
        if (step.thenTalk && end === "next") {
          setTour(null);
          startTask(talkTurns(window.location.pathname));
          handsFreeRef.current = true;
          listenRef.current();
          return;
        }
        i++;
      }
      if (t.token === token) {
        t.token++;
        setTour(null);
        setStatus("idle");
      }
    },
    [runStep, startTask],
  );

  const stopTour = () => {
    const t = tourRef.current;
    if (t.resume) {
      t.token++;
      t.resume();
      setTour(null);
      return;
    }
    endStep("stop");
  };

  const begin = (l: AssistantLang) => {
    markWelcomeSeen();
    setWelcome(false);
    setOpen(true);
    setLang(l);
    langRef.current = l;
    activeRef.current = true;
    startTask(talkTurns(window.location.pathname));
    const greeting = ui(l).greeting;
    if (turnsRef.current.length === 0) setTurns([{ role: "assistant", text: greeting }]);
    setStatus("speaking");
    handsFreeRef.current = true; // after the greeting, start listening straight away
    void say(greeting, l, afterSpeaking);
  };

  const beginTour = (l: AssistantLang) => {
    hush();
    recognitionRef.current?.abort();
    markWelcomeSeen();
    setWelcome(false);
    setOpen(true);
    setLang(l);
    langRef.current = l;
    activeRef.current = true;
    handsFreeRef.current = false;
    startTask(TOUR.length);
    void runTour(l);
  };

  useEffect(() => {
    beginTourRef.current = beginTour;
  });

  const micPressed = () => {
    if (status === "listening") {
      handsFreeRef.current = false;
      recognitionRef.current?.stop();
      return;
    }
    if (status === "speaking") {
      handsFreeRef.current = false;
      hush();
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
    if (tour) {
      const cmd = tourCommand(text);
      setDraft("");
      if (cmd) endStep(cmd);
      return;
    }
    setDraft("");
    handsFreeRef.current = false;
    recognitionRef.current?.abort();
    hush();
    activeRef.current = true;
    void send(text.slice(0, MAX_TURN_CHARS), false);
  };

  const close = () => {
    if (tour) stopTour();
    handsFreeRef.current = false;
    recognitionRef.current?.abort();
    hush();
    setStatus("idle");
    setOpen(false);
  };

  if (!isClient) return null;
  const text = ui(lang);
  const extraLang = browserLang();
  const langChoices = [
    { code: "en", label: "EN" },
    { code: "hi", label: "हिं" },
    ...(extraLang ? [{ code: extraLang.code, label: extraLang.code.toUpperCase() }] : []),
  ];

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
                I&apos;m an AI guide. I can show you around, find a product, or help you sell yours.
                <span lang="hi" className="block">मैं AI गाइड हूँ। मैं आपको टूर करा सकता हूँ, प्रोडक्ट ढूँढ सकता हूँ, या बेचने में मदद कर सकता हूँ।</span>
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => beginTour(suggestedLang())}
              data-testid="assistant-tour-start"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <PlayIcon />
              {suggestedLang() === "hi" ? "3 मिनट का टूर देखें" : "Take the 3-minute tour"}
            </button>
            {(suggestedLang() === "hi" ? (["hi", "en"] as const) : (["en", "hi"] as const)).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => begin(l)}
                lang={l}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <MicIcon />
                {l === "hi" ? "हिन्दी में बोलें" : "Talk in English"}
              </button>
            ))}
            {extraLang && (
              <button
                type="button"
                onClick={() => begin(extraLang.code)}
                lang={extraLang.code}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                <MicIcon />
                {extraLang.label}
              </button>
            )}
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
            startTask(talkTurns(window.location.pathname));
            if (turnsRef.current.length === 0) setTurns([{ role: "assistant", text: ui(lang).greeting }]);
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
          aria-label={text.title}
          data-testid="assistant-panel"
          onKeyDown={(e) => e.key === "Escape" && close()}
          className="fixed inset-x-2 bottom-2 z-50 flex max-h-[min(640px,calc(100dvh-1rem))] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-card sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[380px]"
        >
          <header className="flex items-center gap-2 border-b border-line px-4 py-3">
            <span aria-hidden className="grid size-7 place-items-center rounded-full bg-accent text-accent-ink">
              <MicIcon />
            </span>
            <h2 className="flex-1 text-sm font-semibold text-ink">{text.title}</h2>
            <div role="radiogroup" aria-label="Language" className="flex rounded-lg border border-line-strong p-0.5 text-xs">
              {langChoices.map((c) => (
                <button
                  key={c.code}
                  type="button"
                  role="radio"
                  aria-checked={lang === c.code}
                  disabled={Boolean(tour)}
                  onClick={() => {
                    recognitionRef.current?.abort();
                    hush();
                    handsFreeRef.current = false;
                    setStatus("idle");
                    setLang(c.code);
                  }}
                  className={cx("rounded-md px-2 py-1 font-medium", lang === c.code ? "bg-accent text-accent-ink" : "text-ink-2 hover:text-ink")}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={close}
              aria-label={text.close}
              className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <span aria-hidden>✕</span>
            </button>
          </header>

          {/* Always mounted so the avatar can start on the first turn; shown only in video mode. */}
          <div className={cx("relative h-52 shrink-0 bg-surface-2", !video && "hidden")} data-testid="assistant-avatar">
            <video ref={attachAvatarVideo} playsInline className="size-full object-cover object-[50%_38%]" aria-label={text.aiLabel} />
            <span className="absolute bottom-2 left-2 rounded-full bg-surface/90 px-2 py-0.5 text-[11px] font-medium text-ink-2">{text.aiLabel}</span>
          </div>

          {/* Spec rule 7: the visitor can always switch to voice or text. */}
          <div className="flex items-center gap-2 border-b border-line px-4 py-1.5">
            <span className="flex-1 text-xs text-ink-3">{text.speakWith}</span>
            <div role="radiogroup" aria-label={text.speakWith} data-testid="assistant-output" className="flex rounded-lg border border-line-strong p-0.5 text-xs">
              {(videoAvailable() ? (["video", "voice", "text"] as const) : (["voice", "text"] as const)).map((o) => {
                const current = output === "text" ? "text" : video ? "video" : "voice";
                return (
                  <button
                    key={o}
                    type="button"
                    role="radio"
                    aria-checked={current === o}
                    onClick={() => chooseOutput(o)}
                    className={cx("rounded-md px-2 py-0.5 font-medium", current === o ? "bg-accent text-accent-ink" : "text-ink-2 hover:text-ink")}
                  >
                    {o === "video" ? text.outVideo : o === "voice" ? text.outVoice : text.outText}
                  </button>
                );
              })}
            </div>
          </div>

          {tour && (
            <div className="flex items-center gap-2 border-b border-line px-4 py-2" data-testid="assistant-tour">
              <span className="flex-1 text-xs font-medium text-ink-2 tabular-nums">
                {text.tour} · {tour.index + 1}/{TOUR.length}
              </span>
              <button
                type="button"
                onClick={() => (tour.paused ? tourRef.current.resume?.() : endStep("pause"))}
                className="h-7 rounded-md border border-line-strong px-2 text-xs font-medium text-ink hover:bg-surface-2"
              >
                {tour.paused ? text.resume : text.pause}
              </button>
              <button
                type="button"
                onClick={() => endStep("skip")}
                disabled={tour.paused}
                className="h-7 rounded-md border border-line-strong px-2 text-xs font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
              >
                {text.skip}
              </button>
              <button type="button" onClick={stopTour} className="h-7 rounded-md px-2 text-xs font-medium text-danger hover:bg-surface-2">
                {text.stop}
              </button>
            </div>
          )}

          <div ref={listRef} aria-live="polite" className="flex min-h-[120px] flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
            {turns.map((turn, i) => (
              <div key={i} className={cx("flex flex-col gap-2", turn.role === "user" ? "items-end" : "items-start")}>
                <p
                  lang={/[ऀ-ॿ]/.test(turn.text) ? "hi" : undefined}
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
                        {p.fairFor ? `${text.fair} ${p.fairFor}` : text.standard}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => router.push(p.path)}
                      className="h-8 shrink-0 rounded-lg border border-line-strong px-3 text-xs font-medium text-ink hover:bg-surface-2"
                    >
                      {text.open}
                    </button>
                  </div>
                ))}
              </div>
            ))}
            {interim && (
              <p className="max-w-[85%] self-end rounded-2xl border border-dashed border-accent px-3 py-2 text-sm text-ink-2">{interim}</p>
            )}
            {tour?.waiting && <p className="self-start text-xs text-ink-3">{text.waiting}</p>}
            {status === "thinking" && (
              <p className="flex items-center gap-1 self-start rounded-2xl bg-surface-2 px-3 py-2" aria-label={text.thinking}>
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
            {!tour && (
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
                {status === "listening" ? text.listening : status === "thinking" ? text.thinking : status === "speaking" ? text.speaking : text.tap}
              </button>
            )}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submitDraft();
              }}
            >
              <label className="sr-only" htmlFor="assistant-input">
                {text.placeholder}
              </label>
              <input
                id="assistant-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={MAX_TURN_CHARS}
                placeholder={text.placeholder}
                autoComplete="off"
                className="h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-3 focus:border-accent focus:outline-2 focus:outline-accent/30"
              />
              <button
                type="submit"
                disabled={!draft.trim() || status === "thinking"}
                className="h-9 rounded-lg border border-line-strong px-3 text-sm font-medium text-ink hover:bg-surface-2 disabled:opacity-50"
              >
                {text.send}
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

function PlayIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="size-4" fill="currentColor">
      <path d="M6 4.5v11l9-5.5-9-5.5Z" />
    </svg>
  );
}
