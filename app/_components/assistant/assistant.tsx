"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AssistantLang, AssistantResponse, ClientAction, ProductCard } from "@/lib/assistant/schema";
import { MAX_TURN_CHARS, MAX_TURNS } from "@/lib/assistant/schema";
import {
  heardOwnLine,
  isTourRequest,
  restOfLine,
  SELLER_HOME_MARKER,
  sellerArea,
  TOUR,
  tourCommand,
  tourLang,
  type TourStep,
} from "@/lib/assistant/tour";
import type { CheckoutResult } from "@/lib/checkout/messages";
import { resultSpeech, VOICE_LANGUAGES, type VoiceLanguage } from "@/lib/checkout/voice";
import { cx } from "../cx";
import { createRecognition, noSubscribe, recognitionSupported, speechSupported, type RecognitionLike } from "../speech";
import { createVoiceAdapter } from "./adapters";
import {
  attachAlexVideo,
  closeAlex,
  connectAlex,
  hushAlex,
  isAlexConnected,
  isAlexPaused,
  presentToAlex,
  isAlexHeld,
  quietAlexUntilNextLine,
  resumeAlex,
  setAlexAudioOnly,
  setAlexHold,
  setAlexMuted,
  tellAlex,
  wordsSaidWhenStopped,
  type AlexHandlers,
  type PresentResult,
} from "./alex";
import { addVideoMs, noteVideoFailure, startVideoTask, takeVideoTurn, videoAvailable, videoTurnsLeft } from "./avatar";
import { CHECKOUT_RESULT_EVENT } from "./events";
import { highlight, performActions } from "./page-actions";

/**
 * The FairPrice guide is Alex: a live video avatar with Gemini as its brain (the GCS "Alex" setup),
 * started only from a button. Alex follows the same rules and uses the same tools as the earlier
 * Claude assistant (lib/alex/gemini.ts); prices come only from the server's tools. Alex hears the
 * visitor through the mic and answers in their language. A guided tour (lib/assistant/tour.ts)
 * has Alex say fixed, reviewed lines.
 *
 * If Alex can't start (no connection to Gemini), the visitor gets the earlier guide: the Claude
 * assistant (POST /api/assistant) with the browser's voice. Checkout never depends on either.
 */

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

type Turn = { role: "user" | "assistant"; text: string; products?: ProductCard[] };
type Status = "idle" | "listening" | "thinking" | "speaking";
type AlexState = "off" | "starting" | "live" | "paused";

const STORAGE_KEY = "fp_assistant_v1";
export const WELCOME_KEY = "fp_assistant_welcome_seen";

/** Expected turns for a Talk task (AVATAR_SPEC section 6): seller setup 6, anything else 2. */
const talkTurns = (path: string) => (path.startsWith("/seller") ? 6 : 2);

const LISTEN_LANG: Record<string, string> = { en: "en-IN", hi: "hi-IN" };
const listenLang = (l: string) => LISTEN_LANG[l] ?? l;
/** Payment results have written translations for a few languages; others hear English. */
const resultLang = (l: string): VoiceLanguage => ((VOICE_LANGUAGES as readonly string[]).includes(l) ? (l as VoiceLanguage) : "en");
/** The language of what the visitor said, as far as the script tells (Hindi vs. everything else). */
const spokenLang = (text: string): AssistantLang => (/[ऀ-ॿ]/.test(text) ? "hi" : "en");

const GREET =
  "APP: The visitor just opened the guide. Greet them in one short sentence as Alex, FairPrice's AI guide, and ask whether they want to buy something or sell their own product.";

const UI_EN = {
  title: "Alex · FairPrice AI guide",
  talk: "Talk to Alex",
  live: "Alex is listening · tap to end",
  pausedBtn: "Alex paused · talk or tap to continue",
  pausedOverlay: "Paused · just talk to continue",
  starting: "Starting Alex…",
  tap: "Tap to speak",
  listening: "Listening…",
  thinking: "Working on it…",
  speaking: "Speaking · tap to stop",
  placeholder: "Or type here…",
  send: "Send",
  close: "Close guide",
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
  noAlex: "Alex isn't available right now, so you have the text and voice guide.",
  alexLost: "Alex lost the connection. Tap to talk again.",
  checkPrice: "Please check the price shown on the page: it is the one you pay.",
  pausedNote: "Alex paused because it went quiet. Tap to continue.",
  hold: "Pause",
  unhold: "Resume",
  heldNote: "Alex is paused: he can't hear you. Say “continue” or press Resume.",
  tourPausedNote: "I heard something, so I paused. Say “continue” to go on, or press Resume.",
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
    title: "Alex · FairPrice AI गाइड",
    talk: "Alex से बात करें",
    live: "Alex सुन रहा है · बंद करने के लिए टैप करें",
    pausedBtn: "Alex रुका है · बोलें या टैप करें",
    pausedOverlay: "रुका है · बस बोलिए",
    starting: "Alex शुरू हो रहा है…",
    tap: "बोलने के लिए टैप करें",
    listening: "सुन रहा हूँ…",
    thinking: "काम कर रहा हूँ…",
    speaking: "बोल रहा हूँ · रोकने के लिए टैप करें",
    placeholder: "या यहाँ लिखें…",
    send: "भेजें",
    close: "गाइड बंद करें",
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
    noAlex: "Alex अभी उपलब्ध नहीं है, इसलिए आपके पास टेक्स्ट और आवाज़ वाला गाइड है।",
    alexLost: "Alex का कनेक्शन टूट गया। फिर से बात करने के लिए टैप करें।",
    checkPrice: "कृपया पेज पर दिखी कीमत देखें: आप वही कीमत देंगे।",
    pausedNote: "शांति होने की वजह से Alex रुक गया। जारी रखने के लिए टैप करें।",
    hold: "रोकें",
    unhold: "जारी रखें",
    heldNote: "Alex रुका है: वह आपको नहीं सुन सकता। “जारी रखो” बोलें या 'जारी रखें' दबाएँ।",
    tourPausedNote: "कुछ सुनाई दिया, इसलिए मैं रुक गया। आगे बढ़ने के लिए “जारी रखो” बोलें या 'जारी रखें' दबाएँ।",
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

/** True when every word of `caption` appears, in order, in `line` (punctuation and case ignored). */
function isPartOf(caption: string, line: string): boolean {
  const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const c = words(caption);
  if (c.length === 0) return true;
  const l = words(line);
  for (let i = 0; i + c.length <= l.length; i++) if (c.every((w, j) => l[i + j] === w)) return true;
  return false;
}

const marker = (name: string) => document.querySelector<HTMLElement>(`[data-assistant-highlight="${name}"]`);
/** "signin", "in" or null (still loading): judged by what the page shows, not only its address. */
const sellerAreaNow = () =>
  sellerArea(window.location.pathname, { passwordField: !!marker("password_field"), sellerHome: !!marker(SELLER_HOME_MARKER) });

type TourState = { index: number; paused: boolean; waiting: boolean };
/** "listen": the visitor talked over a tour line without a command; the tour waits (Alex answers). */
type StepEnd = "next" | "skip" | "stop" | "pause" | "listen" | "repeat";

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
  const [alex, setAlex] = useState<AlexState>("off");
  /** Alex is on hold (Pause): hears nothing, says nothing. */
  const [held, setHeld] = useState(false);

  const recognitionRef = useRef<RecognitionLike | null>(null);
  const handsFreeRef = useRef(false);
  const langRef = useRef(lang);
  const turnsRef = useRef(turns);
  const activeRef = useRef(turns.length > 0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef(false);
  const outputRef = useRef(output);
  const micBlockedRef = useRef(false);
  const alexRef = useRef<AlexState>("off");
  /** Index of the bubble Alex / the visitor is currently speaking into (captions arrive in pieces). */
  const alexBubbleRef = useRef<number | null>(null);
  const userBubbleRef = useRef<number | null>(null);
  const pendingCardsRef = useRef<ProductCard[]>([]);
  /** True while Alex says a fixed line (tour, payment result). */
  const scriptingRef = useRef(false);
  /** The last fixed line Alex said, until he says something of his own. */
  const lastScriptRef = useRef("");
  const videoSinceRef = useRef(0);
  /** The latest beginTour, so callbacks memoised earlier can start the tour. */
  const beginTourRef = useRef<(l: AssistantLang) => void>(() => {});
  const lastUserSpokeRef = useRef(0);
  /** The part of the visitor's current utterance whose command was already acted on. */
  const cmdSeenRef = useRef("");
  /** Times in a row a tour line was cut off without the visitor saying anything (noise, echo). */
  const noiseRef = useRef({ step: "", count: 0 });
  /** The visitor spoke while Alex slept after silence: wake him and pass on what they said. */
  const wakeByVoiceRef = useRef<(heard: string) => Promise<void>>(async () => {});
  /** "Continue" said by the visitor: carry on the paused tour, or release Alex from hold. */
  const resumeByVoiceRef = useRef<() => void>(() => {});
  const stopTourRef = useRef<() => void>(() => {});
  /** Put Alex on hold or release him (set below; used by the caption handler). */
  const holdRef = useRef<(on: boolean) => void>(() => {});
  /** The latest endStep, for Alex's caption handler (set up before endStep exists). */
  const endStepRef = useRef<(end: StepEnd) => void>(() => {});
  /** A paused tour step to pick up mid-line: its id and how many words Alex had said. */
  const resumeFromRef = useRef<{ step: string; words: number } | null>(null);
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

  const setAlexState = useCallback((s: AlexState) => {
    alexRef.current = s;
    setAlex(s);
  }, []);

  /** Stop all speech now: Alex and the browser voice. */
  const hush = useCallback(() => {
    hushAlex();
    voiceAdapter.stop();
  }, []);

  useEffect(() => {
    if (speechSupported()) window.speechSynthesis.getVoices();
    return () => {
      recognitionRef.current?.abort();
      closeAlex();
      voiceAdapter.stop();
    };
  }, []);

  const setVideoMode = useCallback((on: boolean) => {
    if (videoRef.current && !on && videoSinceRef.current) addVideoMs(Date.now() - videoSinceRef.current);
    videoSinceRef.current = on ? Date.now() : 0;
    videoRef.current = on;
    setVideo(on);
  }, []);

  /** Start a task: video for its expected turns plus two (AVATAR_SPEC section 6). */
  const startTask = useCallback((expectedTurns: number) => {
    if (outputRef.current === "video" && videoAvailable()) startVideoTask(expectedTurns);
  }, []);

  // ---- Alex ----

  /** Show a caption in the bubble for the current turn (Alex's words arrive in pieces). */
  const caption = useCallback((who: "alex" | "user", text: string) => {
    if (who === "alex" && scriptingRef.current) return;
    // A late caption that is just part of the fixed line he was saying: that line is already shown.
    if (who === "alex" && lastScriptRef.current && isPartOf(text, lastScriptRef.current)) return;
    if (who === "alex") lastScriptRef.current = "";
    const ref = who === "alex" ? alexBubbleRef : userBubbleRef;
    // Taken out here, not inside the updater: React may run an updater twice in development.
    const cards = who === "alex" ? pendingCardsRef.current : [];
    if (cards.length) pendingCardsRef.current = [];
    setTurns((t) => {
      const next = [...t];
      const i = ref.current;
      if (i !== null && next[i]) next[i] = { ...next[i], text };
      else {
        ref.current = next.length;
        next.push({ role: who === "alex" ? "assistant" : "user", text });
      }
      if (cards.length) {
        const at = ref.current!;
        next[at] = { ...next[at], products: [...(next[at].products ?? []), ...cards] };
      }
      return next;
    });
  }, []);

  /** Run one of Alex's tool calls: the same server tools as the assistant, then the page actions. */
  const runAlexTool = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      if (name === "start_tour") {
        setTimeout(() => beginTourRef.current(langRef.current), 0);
        return { ok: true, note: "The tour is starting now. Say nothing." };
      }
      if (name === "resume_tour") {
        // GCS resume_demo: Alex understood "let's continue", in whatever words or language.
        if (!tourRef.current.resume && !tourRef.current.step) return { ok: false, note: "No tour is running. Say nothing." };
        setTimeout(() => resumeByVoiceRef.current(), 0);
        return { ok: true, note: "Continuing the tour now. Say nothing; the app sends you the next line." };
      }
      const res = await fetch("/api/alex/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, args, path: window.location.pathname + window.location.search }),
      });
      if (!res.ok) return { error: "That step isn't available right now." };
      const out = (await res.json()) as { result: string; actions: ClientAction[]; products: ProductCard[] };
      if (out.products.length) pendingCardsRef.current.push(...out.products);
      const problems = await performActions(out.actions, router);
      if (problems.length) setNote(ui(langRef.current).couldNot);
      return { result: out.result };
    },
    [router],
  );

  /**
   * Start Alex from a tap. Returns false if he can't start (the caller falls back to the old guide).
   * `resume`: pick the visitor's earlier conversation in this tab up again instead of a new one.
   */
  const startAlex = useCallback(
    async (greet: boolean, resume = false): Promise<boolean> => {
      setAlexState("starting");
      const handlers: AlexHandlers = {
        onToolCall: runAlexTool,
        onCaption: (who, text) => {
          caption(who, text);
          if (who === "user") {
            lastUserSpokeRef.current = Date.now();
            const l = spokenLang(text);
            if (l !== langRef.current) {
              langRef.current = l;
              setLang(l);
            }
            // During the tour, "skip" / "stop" / "pause" said to Alex steer the tour; outside it,
            // "pause" / "wait" puts Alex on hold (GCS).
            // Their words arrive in pieces ("skip", then "skip please"): a command counts once.
            const seen = cmdSeenRef.current;
            const fresh = seen && text.startsWith(seen) ? text.slice(seen.length) : text;
            const cmd = tourCommand(fresh);
            cmdSeenRef.current = cmd ? text : text.startsWith(seen) ? seen : "";
            if (cmd === "resume") resumeByVoiceRef.current();
            else if (cmd && tourRef.current.step) endStepRef.current(cmd);
            else if (cmd === "pause" && !tourRef.current.resume) holdRef.current(true); // not while a tour is paused
          }
        },
        onTurnComplete: () => {
          alexBubbleRef.current = null;
          userBubbleRef.current = null;
          // Video budget: n + 2 Alex turns per task, then voice (spec section 6).
          if (videoRef.current) {
            if (videoSinceRef.current) addVideoMs(Date.now() - videoSinceRef.current);
            videoSinceRef.current = Date.now();
            if (!takeVideoTurn()) {
              setVideoMode(false);
              setNote(ui(langRef.current).switching);
              void setAlexAudioOnly(true);
            }
          }
        },
        onSpeaking: (s) => setStatus(s ? "speaking" : "idle"),
        onMode: (m) => setVideoMode(m === "video" && outputRef.current === "video"),
        onUnfaithful: () => setNote(ui(langRef.current).checkPrice),
        onPaused: () => {
          setAlexState("paused");
          // Keep his last frame on screen (the box doesn't vanish); only stop counting video time.
          if (videoRef.current && videoSinceRef.current) addVideoMs(Date.now() - videoSinceRef.current);
          videoSinceRef.current = 0;
          setStatus("idle");
        },
        onClosed: () => {
          setAlexState("off");
          setVideoMode(false);
          setStatus("idle");
          setNote(ui(langRef.current).alexLost);
        },
      };
      const audioOnly = outputRef.current !== "video" || !videoAvailable() || videoTurnsLeft() <= 0;
      try {
        const { mic } = await connectAlex({ lang: langRef.current, audioOnly, resume }, handlers);
        setAlexMuted(outputRef.current === "text");
        setAlexState("live");
        setNote(mic ? null : ui(langRef.current).blocked);
        if (greet) void tellAlex(GREET);
        return true;
      } catch {
        if (!audioOnly) noteVideoFailure();
        setAlexState("off");
        setVideoMode(false);
        return false;
      }
    },
    [caption, runAlexTool, setAlexState, setVideoMode],
  );

  /** Continue a paused Alex (same conversation). */
  const continueAlex = useCallback(async () => {
    try {
      await resumeAlex();
      setAlexState("live");
      setNote(null);
    } catch {
      setAlexState("off");
    }
  }, [setAlexState]);

  // ---- the earlier guide (Claude + browser voice), used when Alex can't start ----

  /** Speak with the browser voice (or not at all in text mode). */
  const say = useCallback(async (text: string, l: AssistantLang, onDone: () => void) => {
    if (outputRef.current === "text") return onDone();
    await voiceAdapter.speak(text, l);
    onDone();
  }, []);

  const listenRef = useRef<() => void>(() => {});

  const afterSpeaking = useCallback(() => {
    setStatus("idle");
    if (handsFreeRef.current) listenRef.current();
  }, []);

  const send = useCallback(
    async (text: string, viaVoice: boolean) => {
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
      const filler = viaVoice && outputRef.current !== "text" ? setTimeout(() => void voiceAdapter.speak(ui(l).filler, l), 1200) : null;

      let data: (AssistantResponse & { message?: string }) | null = null;
      let ok = false;
      try {
        const res = await fetch("/api/assistant", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lang: l, messages: conversationFor(next), path: window.location.pathname + window.location.search }),
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

  /** Listen once with the browser's recognition (earlier guide). `onHeard` is used by the tour for skip/stop. */
  const startListening = useCallback(
    (onHeard?: (heard: string) => void) => {
      const l = langRef.current;
      if (!recognitionSupported()) {
        if (onHeard) return;
        setNote(ui(l).noRecognition);
        handsFreeRef.current = false;
        return;
      }
      if (!onHeard) hush();
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
          micBlockedRef.current = true;
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

  // ---- speaking a fixed line (tour lines, payment results): Alex if he's on, else the voice ----

  const sayLine = useCallback(
    async (text: string, l: AssistantLang, opts: { show?: boolean } = {}): Promise<PresentResult | "voice"> => {
      // The line's bubble in the chat. Not again when it is already there: a paused line picked up
      // where it stopped (`show: false`), or a line said again right after itself.
      const addBubble = () =>
        setTurns((t) => {
          const last = t[t.length - 1];
          if (opts.show === false || (last?.role === "assistant" && last.text === text)) return t;
          return [...t, { role: "assistant", text }];
        });
      if (alexRef.current === "paused") await continueAlex(); // asleep after silence: wake him for the line
      if (alexRef.current === "live" || alexRef.current === "paused") {
        addBubble();
        alexBubbleRef.current = null;
        setStatus("speaking");
        // Alex's live captions of a fixed line would only repeat it: the bubble above shows it exactly.
        scriptingRef.current = true;
        lastScriptRef.current = text;
        const r = await presentToAlex(text);
        scriptingRef.current = false;
        alexBubbleRef.current = null;
        setStatus("idle");
        // Only when Alex is really gone does the browser voice say the line instead. A line the
        // visitor stopped (skip / stop / pause) stays stopped: no second voice.
        if (r !== "closed" || (alexRef.current as AlexState) !== "off") return r; // may have changed while he spoke
      } else addBubble();
      setStatus("speaking");
      await new Promise<void>((resolve) => void say(text, l, resolve));
      setStatus("idle");
      return "voice";
    },
    [say, continueAlex],
  );

  // Read the payment result aloud when the visitor has been using the guide (the tour reads it itself).
  useEffect(() => {
    const onResult = (event: Event) => {
      if (!activeRef.current || tourRef.current.step) return;
      handsFreeRef.current = false;
      void sayLine(resultSpeech(resultLang(langRef.current), (event as CustomEvent<CheckoutResult>).detail), langRef.current);
    };
    window.addEventListener(CHECKOUT_RESULT_EVENT, onResult);
    return () => window.removeEventListener(CHECKOUT_RESULT_EVENT, onResult);
  }, [sayLine]);

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
  useEffect(() => {
    endStepRef.current = endStep;
  }, [endStep]);

  /** Run one step. */
  const runStep = useCallback(
    async (step: TourStep, l: AssistantLang, signal: AbortSignal): Promise<void> => {
      if (step.path) {
        if (step.onlyIfSignedOut) {
          // /seller sends signed-out visitors to /seller/sign-in; signed-in sellers stay on /seller.
          router.push(step.path);
          const where = await waitUntil(sellerAreaNow, 10_000, signal);
          // Neither page showed up: skip the seller part (T6 → T8) rather than run it signed out.
          if (where === null && !signal.aborted) tourRef.current.end = "skip";
          if (where !== "signin") return;
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
      if (signal.aborted) return;

      // Without Alex, listen for "skip" / "stop" with the browser's recognition (Alex hears them himself).
      // While a line plays, a command word the line itself says ("…or say skip") is ignored.
      let speakingLine: string | null = null;
      let stepDone = false;
      const listen = () => {
        if (alexRef.current !== "off" || stepDone || signal.aborted || micBlockedRef.current || !recognitionSupported()) return;
        startListening((heard) => {
          const cmd = tourCommand(heard);
          if (cmd && cmd !== "resume" && !heardOwnLine(cmd, speakingLine)) endStep(cmd);
          else setTimeout(listen, 300);
        });
      };

      try {
        listen();
        const full = step.line[tourLang(langRef.current || l)];
        // Picked up after Pause: from the sentence Alex was in, and the line is already in the chat.
        const pausedAt = resumeFromRef.current?.step === step.id ? resumeFromRef.current.words : 0;
        resumeFromRef.current = null;
        const line = restOfLine(full, pausedAt);
        speakingLine = line;
        const said = await sayLine(line, langRef.current || l, { show: pausedAt === 0 });
        // The visitor talked over Alex. Gemini cuts him off at once, but the words ("pause", "skip"…)
        // arrive a moment later: wait for them, so the command acts on THIS step (GCS: a voice
        // interruption pauses the tour). No command: the tour waits while Alex answers them.
        if (said === "interrupted" && !signal.aborted) {
          const cutAt = Date.now();
          await waitUntil(() => (signal.aborted ? true : null), 2500);
          if (!signal.aborted) {
            // Only real words pause the tour. A cut-off with nothing said (room noise, Alex's own
            // echo, a stray turn end) just starts the line again, twice at most.
            const spoke = lastUserSpokeRef.current > cutAt - 300;
            const n = noiseRef.current.step === step.id ? noiseRef.current.count + 1 : 1;
            noiseRef.current = { step: step.id, count: spoke ? 0 : n };
            endStep(spoke || n > 2 ? "listen" : "repeat");
          }
        } else if (said === "done") {
          noiseRef.current = { step: "", count: 0 };
          // Between lines Alex stays quiet (GCS). Not at a waiting step: there he may answer the visitor.
          if (!step.wait) quietAlexUntilNextLine();
        }
        speakingLine = null;
        if (signal.aborted || !step.wait) return;

        // Wait for the visitor: the payment result, or the seller signing in.
        setTour((s) => (s ? { ...s, waiting: true } : s));
        let result: CheckoutResult | null = null;
        const onResult = (e: Event) => (result = (e as CustomEvent<CheckoutResult>).detail);
        window.addEventListener(CHECKOUT_RESULT_EVENT, onResult);
        try {
          if (step.wait === "checkout_result") await waitUntil(() => result, 3 * 60_000, signal);
          else {
            const signedIn = await waitUntil(() => (sellerAreaNow() === "in" ? true : null), 5 * 60_000, signal);
            // Still signed out after the wait: skip the seller part (T6 → T8).
            if (!signedIn && !signal.aborted) tourRef.current.end = "skip";
          }
        } finally {
          window.removeEventListener(CHECKOUT_RESULT_EVENT, onResult);
          setTour((s) => (s ? { ...s, waiting: false } : s));
        }
        // The result card's own message, as written (spec: nothing added about the payment).
        if (result && !signal.aborted) await sayLine(resultSpeech(resultLang(langRef.current), result), langRef.current);
      } finally {
        stepDone = true;
        recognitionRef.current?.abort();
      }
    },
    [router, sayLine, startListening, endStep],
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
        if (end === "repeat") continue; // "continue" said over the line: present this step again
        if (end === "listen") {
          // GCS: the visitor talked over Alex, so the tour pauses and Alex answers them. "Continue"
          // (said, typed, Resume, or Alex calling resume_tour) presents this step again.
          setTour({ index: i, paused: true, waiting: false });
          const pausedAt = Date.now();
          // Often it was only room noise: if nobody says anything, Alex checks in (as in GCS).
          const checkIn = setTimeout(() => {
            if (t.resume && lastUserSpokeRef.current < pausedAt && !isAlexHeld() && alexRef.current === "live") {
              void tellAlex(
                "APP: The tour paused because something interrupted you, but the visitor hasn't said anything since (maybe background noise). Ask in one short sentence whether they had a question or would like to continue. If they say continue, call resume_tour.",
              );
            }
          }, 8000);
          await new Promise<void>((resolve) => (t.resume = resolve));
          clearTimeout(checkIn);
          t.resume = null;
          continue;
        }
        if (end === "pause") {
          // Where he was in the line (hush() noted it when Pause was pressed), for Resume.
          const words = wordsSaidWhenStopped();
          setTour({ index: i, paused: true, waiting: false });
          setAlexHold(true); // GCS hold: Alex hears and says nothing until Resume
          await new Promise<void>((resolve) => (t.resume = resolve));
          t.resume = null;
          setAlexHold(false);
          if (isAlexPaused()) await continueAlex();
          resumeFromRef.current = { step: step.id, words };
          continue; // the paused step again, from the sentence he was in
        }
        // Skipping the seller sign-in skips the seller part (spec: T6 → T8).
        if (step.id === "T7" && end === "skip") {
          i = TOUR.findIndex((s) => s.id === "T8");
          continue;
        }
        if (step.thenTalk && end === "next") {
          setTour(null);
          startTask(talkTurns(window.location.pathname));
          if (alexRef.current === "off") {
            handsFreeRef.current = true;
            listenRef.current();
          }
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
    [runStep, startTask, continueAlex],
  );

  const stopTour = () => {
    const t = tourRef.current;
    setAlexHold(false);
    if (t.resume) {
      t.token++;
      t.resume();
      setTour(null);
      return;
    }
    endStep("stop");
  };

  /** Pause / resume Alex in Talk mode (GCS hold). */
  const hold = useCallback(
    (on: boolean) => {
      if (on === isAlexHeld()) return;
      setAlexHold(on);
      setHeld(on);
      if (on) setStatus("idle");
      else if (isAlexPaused()) void continueAlex();
    },
    [continueAlex],
  );
  useEffect(() => {
    holdRef.current = hold;
  }, [hold]);

  useEffect(() => {
    stopTourRef.current = stopTour;
    resumeByVoiceRef.current = () => {
      if (tourRef.current.resume) tourRef.current.resume();
      else if (tourRef.current.step) endStep("repeat"); // said over a playing line: start it again
      else if (isAlexHeld()) hold(false);
      else if (alexRef.current === "paused") void continueAlex();
    };
    wakeByVoiceRef.current = async (heard) => {
      await continueAlex();
      setTurns((t) => [...t, { role: "user", text: heard }]);
      userBubbleRef.current = null;
      alexBubbleRef.current = null;
      void tellAlex(heard);
    };
  });

  // While Alex is paused his mic sends Gemini silence, so he can't hear "continue". As in GCS (its
  // "Hi Alex" wake word), the browser's own speech recognition listens locally meanwhile, only for
  // "continue" (or "stop" in the tour). Nothing of it reaches Gemini.
  const tourPaused = Boolean(tour?.paused);
  useEffect(() => {
    const sleeping = alex === "paused" && !held && !tourPaused; // paused after 20 s of silence
    if (!(held || tourPaused || sleeping) || alex === "off") return;
    let active = true;
    const loop = () => {
      if (!active || micBlockedRef.current) return;
      startListening((heard) => {
        if (!active) return;
        const cmd = tourCommand(heard);
        if (cmd === "resume") return resumeByVoiceRef.current();
        if (cmd === "stop" && tourRef.current.resume) return stopTourRef.current();
        // Asleep while a tour step waits for the visitor: "skip" / "stop" / "pause" still steer the
        // tour (the next line wakes Alex); anything else isn't sent to him as chat.
        if (sleeping && tourRef.current.step) {
          if (cmd) return endStepRef.current(cmd);
          return void setTimeout(loop, 300);
        }
        // Asleep after silence: whatever they say wakes Alex, who answers it (GCS: speaking wakes him).
        if (sleeping && heard) return void wakeByVoiceRef.current(heard);
        setTimeout(loop, 300);
      });
    };
    loop();
    return () => {
      active = false;
      recognitionRef.current?.abort();
    };
  }, [held, tourPaused, alex, startListening]);

  // ---- starting the guide (only ever from a tap) ----

  const openGuide = () => {
    markWelcomeSeen();
    setWelcome(false);
    setOpen(true);
    activeRef.current = true;
  };

  /** "Talk to Alex". Falls back to the earlier guide if Alex can't start. */
  const talk = async () => {
    openGuide();
    startTask(talkTurns(window.location.pathname));
    // A conversation already on screen goes on (same Gemini session, no second greeting); only a
    // visitor who hasn't talked to Alex yet in this tab is greeted.
    const fresh = turnsRef.current.length === 0;
    if (await startAlex(fresh, !fresh)) return;
    setNote(ui(langRef.current).noAlex);
    const l = langRef.current;
    const greeting = ui(l).greeting;
    handsFreeRef.current = true;
    // The earlier guide greets once per conversation: tapped again while Alex is still away, it
    // just listens instead of adding (and saying) the same greeting again.
    if (turnsRef.current.some((t) => t.role === "assistant" && t.text === greeting)) {
      afterSpeaking();
      return;
    }
    setTurns((t) => [...t, { role: "assistant", text: greeting }]);
    setStatus("speaking");
    void say(greeting, l, afterSpeaking);
  };

  const beginTour = async (l: AssistantLang) => {
    hush();
    recognitionRef.current?.abort();
    openGuide();
    handsFreeRef.current = false;
    startTask(TOUR.length);
    if (alexRef.current === "off") await startAlex(false, turnsRef.current.length > 0);
    else if (alexRef.current === "paused") await continueAlex();
    void runTour(l);
  };

  useEffect(() => {
    beginTourRef.current = (l) => void beginTour(l);
  });

  const mainButton = () => {
    if (alex === "live") {
      setAlexHold(false);
      setHeld(false);
      closeAlex();
      setAlexState("off");
      setVideoMode(false);
      setStatus("idle");
      return;
    }
    if (alex === "paused") return void continueAlex();
    if (alex === "starting") return;
    // The earlier guide's mic, when Alex isn't running.
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
    void talk();
  };

  /** The visitor chose how the guide speaks (spec rule 7: switch to voice or text). */
  const chooseOutput = (o: Output) => {
    outputRef.current = o;
    setOutput(o);
    saveOutput(o);
    voiceAdapter.stop();
    setAlexMuted(o === "text");
    if (alexRef.current !== "off") {
      // Back to video only while this task's budget lasts; choosing it doesn't refill the budget.
      const wantVideo = o === "video" && videoAvailable() && videoTurnsLeft() > 0;
      void setAlexAudioOnly(!wantVideo);
      if (!wantVideo) setVideoMode(false);
    }
  };

  const submitDraft = () => {
    const text = draft.trim();
    if (!text || status === "thinking") return;
    setDraft("");
    if (tour) {
      const cmd = tourCommand(text);
      if (cmd === "resume") resumeByVoiceRef.current();
      else if (cmd) endStep(cmd);
      return;
    }
    activeRef.current = true;
    if (isTourRequest(text)) {
      setTurns((t) => [...t, { role: "user", text }]);
      void beginTour(langRef.current);
      return;
    }
    if (alexRef.current === "live" || alexRef.current === "paused") {
      setTurns((t) => [...t, { role: "user", text }]);
      userBubbleRef.current = null;
      alexBubbleRef.current = null; // his answer gets its own bubble, below this message
      setAlexState("live");
      void tellAlex(text.slice(0, MAX_TURN_CHARS));
      return;
    }
    handsFreeRef.current = false;
    recognitionRef.current?.abort();
    hush();
    void send(text.slice(0, MAX_TURN_CHARS), false);
  };

  const close = () => {
    if (tour) stopTour();
    setAlexHold(false);
    setHeld(false);
    handsFreeRef.current = false;
    recognitionRef.current?.abort();
    hush();
    closeAlex();
    setAlexState("off");
    setVideoMode(false);
    setStatus("idle");
    setOpen(false);
  };

  if (!isClient) return null;
  const text = ui(lang);
  const alexOn = alex === "live" || alex === "paused" || isAlexConnected() || isAlexPaused();
  const mainLabel =
    alex === "live"
      ? status === "speaking"
        ? text.speaking.replace(/·.*/, "· Alex")
        : text.live
      : alex === "paused"
        ? text.pausedBtn
        : alex === "starting"
          ? text.starting
          : status === "listening"
            ? text.listening
            : status === "thinking"
              ? text.thinking
              : status === "speaking"
                ? text.speaking
                : text.talk;

  return (
    <>
      {welcome && !open && (
        <section
          aria-label="FairPrice guide"
          data-testid="assistant-welcome"
          className="fixed inset-x-3 bottom-3 z-50 flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-card sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[360px]"
        >
          <div className="flex items-start gap-3">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-accent-ink">
              <MicIcon />
            </span>
            <div className="flex flex-col gap-1">
              <h2 className="text-sm font-semibold text-ink">Need a hand?</h2>
              <p className="text-xs leading-relaxed text-ink-2">
                I&apos;m Alex, FairPrice&apos;s AI guide. I can show you around, find a product, or help you sell yours. Talk to me in your language.
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => void beginTour("en")}
              data-testid="assistant-tour-start"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <PlayIcon />
              Take the 3-minute tour
            </button>
            <button
              type="button"
              onClick={() => void talk()}
              data-testid="assistant-talk"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-4 text-sm font-medium text-ink transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <MicIcon />
              Talk to Alex
            </button>
            <button
              type="button"
              onClick={() => {
                markWelcomeSeen();
                setWelcome(false);
              }}
              className="h-9 rounded-lg text-sm font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              Explore on my own
            </button>
          </div>
        </section>
      )}

      {!open && !welcome && (
        <button
          type="button"
          onClick={() => void talk()}
          aria-label="Talk to Alex, the FairPrice guide"
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
          className="fixed inset-x-2 bottom-2 z-50 flex max-h-[min(720px,calc(100dvh-1rem))] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-card sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[380px]"
        >
          <header className="flex items-center gap-2 border-b border-line px-4 py-3">
            <span aria-hidden className="grid size-7 place-items-center rounded-full bg-accent text-accent-ink">
              <MicIcon />
            </span>
            <h2 className="flex-1 text-sm font-semibold text-ink">{text.title}</h2>
            <button
              type="button"
              onClick={close}
              aria-label={text.close}
              className="grid size-8 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
            >
              <span aria-hidden>✕</span>
            </button>
          </header>

          {/* Always mounted so Alex can draw into it as soon as he starts; shown only in video mode. */}
          {/* The avatar video is a tall portrait (704×1280) whose head runs from about 21% to 57% of its
              height. A 280 px box cropped at 32% shows 19%–60%: his whole face, hair to chin. */}
          <div className={cx("relative h-[280px] shrink-0 bg-surface-2", !video && "hidden")} data-testid="assistant-avatar">
            <video ref={attachAlexVideo} playsInline className="size-full object-cover object-[50%_32%]" aria-label={text.aiLabel} />
            {alex === "paused" && !tour && (
              <span className="absolute inset-x-0 top-2 mx-auto w-fit rounded-full bg-surface/90 px-3 py-1 text-xs font-medium text-ink-2">{text.pausedOverlay}</span>
            )}
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
            {tour?.paused && <p className="self-start text-xs text-ink-3">{text.tourPausedNote}</p>}
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
            {held && !tour && <p className="text-xs text-ink-3">{text.heldNote}</p>}
            {(!tour || !alexOn) && (
              <div className="flex gap-2">
              <button
                type="button"
                onClick={mainButton}
                aria-pressed={alex === "live" || status === "listening"}
                disabled={status === "thinking" || alex === "starting"}
                data-testid="assistant-main"
                className={cx(
                  "inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60",
                  status === "listening" ? "bg-danger text-white" : "bg-accent text-accent-ink hover:bg-accent-strong",
                )}
              >
                <MicIcon />
                {mainLabel}
              </button>
              {alex === "live" && !tour && (
                <button
                  type="button"
                  onClick={() => hold(!held)}
                  aria-pressed={held}
                  data-testid="assistant-hold"
                  className="h-11 shrink-0 rounded-xl border border-line-strong px-4 text-sm font-medium text-ink hover:bg-surface-2"
                >
                  {held ? text.unhold : text.hold}
                </button>
              )}
              </div>
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
