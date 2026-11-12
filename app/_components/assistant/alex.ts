/**
 * Alex in the browser: one live Gemini session through the bridge at /ws/alex (ported from the
 * GCS "Alex" client, src/tour/alexLive.ts). The mic streams to Gemini, whose own voice detection
 * handles turn-taking and barge-in; Gemini streams back the avatar as fragmented MP4 (or PCM audio
 * in voice-only mode), plus captions and tool calls. Alex's rules and tools are set on the server.
 *
 * AVATAR_SPEC section 6 on a live session: after 20 s with nobody talking, Alex pauses (the stream
 * closes) and picks the same conversation up again, via Gemini's resume handle, on the next tap,
 * message or tour step. A hidden tab pauses him too. Only one session at a time.
 */

export type AlexMode = "video" | "audio";
/**
 * How a line ended: "done"; "interrupted" = the visitor talked over him (Gemini's voice detection);
 * "stopped" = stopped from the page (skip / stop / pause button); "closed" = the session ended.
 */
export type PresentResult = "done" | "interrupted" | "stopped" | "closed";

export interface AlexHandlers {
  /** Run a tool; the object returned is sent back to Alex as its result. */
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** The line so far: Alex's words, or what Gemini heard the visitor say. */
  onCaption: (who: "alex" | "user", text: string) => void;
  /** Alex finished a turn in which he said something. */
  onTurnComplete: () => void;
  onSpeaking: (speaking: boolean) => void;
  onMode: (mode: AlexMode) => void;
  /** Alex said a number no tool, visitor or app text gave him. */
  onUnfaithful: () => void;
  /** Paused after silence (resumable), or ended for good. */
  onPaused: () => void;
  onClosed: (reason: string) => void;
}

const SILENCE_PAUSE_MS = 20_000;
const VIDEO_STALL_MS = 10_000;
const RECONNECT_TRIES = 3;

let ws: WebSocket | null = null;
let handlers: AlexHandlers | null = null;
let setupMsg: { path: string; lang?: string } | null = null;
let resumeHandle: string | null = null;
let mode: AlexMode = "video";
let forceAudio = false;
let muted = false; // text mode: captions only
let reconnecting = false;
let paused = false;
let lastActivity = 0;
let lastVideoAt = 0;
let watchTimer: ReturnType<typeof setInterval> | null = null;
let videoEl: HTMLVideoElement | null = null;
let micCtx: AudioContext | null = null;
let micStream: MediaStream | null = null;
let outCtx: AudioContext | null = null;
let nextAudioTime = 0;
const audioSources = new Set<AudioBufferSourceNode>();

// From GCS: hold (the mic sends silence and nothing Alex says is played until released), a cut-off
// turn whose remaining words are dropped, and quiet between tour lines (anything new Alex starts on
// his own right after a line is neither played nor captioned, until the next line or 8 s).
let micHeld = false;
let outputHeld = false;
let dropTurn = false;
let quietUntil = 0;
const QUIET_MAX_MS = 8000;
const quiet = () => Date.now() < quietUntil;
// A new line cut in on an older turn: that turn's last chunks are dropped (800 ms at most).
let dropOldTurnUntil = 0;
/** Nothing Alex generates right now may be heard or shown. */
const outputBlocked = () => outputHeld || dropTurn || quiet() || Date.now() < dropOldTurnUntil;

let turnActive = false;
let alexLine = "";
let userLine = "";
/** The fixed line Alex is saying: how many words it has, and whether Gemini reported a turn end during it. */
let pending: { resolve: (r: PresentResult) => void; words: number; sawEnd?: boolean } | null = null;
const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
/**
 * Has Alex actually said the pending line? Judged by his own transcript, not by timing: Gemini also
 * ends turns that aren't the line (its reply to the visitor's "skip", a turn we cut in on), and
 * those ends arrive around the same moment. At least half the line's words must have been heard.
 */
const lineSaid = () => !!pending && wordCount(spokenWords(alexLine)) >= Math.ceil(pending.words * 0.5);
const lineStarted = () => wordCount(spokenWords(alexLine)) > 0;
// A new SCRIPT cuts in on whatever Alex was still generating; that old turn's 'interrupted' /
// 'turn_complete' arrive just after and must not end the new one.
// ponytail: time window, track turn ids if Gemini ever exposes them
const OLD_TURN_WINDOW_MS = 1500;
let selfInterruptUntil = 0;
/** A turn was still running when the new line was sent: its end (just after) isn't the new line's. */
let oldTurnOpen = false;
const isOldTurnEnd = () => {
  if (!oldTurnOpen || Date.now() >= selfInterruptUntil) return false;
  oldTurnOpen = false;
  return true;
};

// Gemini's transcript placeholders ("<noise>", "{pause}") and our own markers, should he read one aloud.
const spokenWords = (s: string) =>
  s
    .replace(/<[a-z][^>]*(>|$)/gi, "")
    .replace(/\{[a-z][^}]*(\}|$)/gi, "")
    .replace(/^\s*(script|app)\s*:\s*/i, "")
    .trim();
/** When the visitor's words last arrived (their speech makes Gemini start a reply turn of its own). */
let lastUserTextAt = 0;

export const isAlexConnected = (): boolean => !!ws && ws.readyState === WebSocket.OPEN;
export const isAlexPaused = (): boolean => paused;
export const alexMode = (): AlexMode => mode;

/** The panel's <video>; Alex draws into it. */
export function attachAlexVideo(el: HTMLVideoElement | null): void {
  videoEl = el;
}

// ---- fragmented-MP4 avatar player (from GCS, which took it from the qcraque avatar) ----

const MSE: typeof MediaSource | undefined =
  typeof window === "undefined" ? undefined : (window.MediaSource ?? (window as Window & { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource);
let mse: MediaSource | null = null;
let sb: SourceBuffer | null = null;
let boxes: Uint8Array<ArrayBufferLike> = new Uint8Array();
let initSeg: Uint8Array[] = [];
let moof: Uint8Array | null = null;
let queue: Uint8Array[] = [];
let codec = 'video/mp4; codecs="avc1.42c020, mp4a.40.2"';
let seekToLive = true;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const r = new Uint8Array(a.length + b.length);
  r.set(a);
  r.set(b, a.length);
  return r;
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

function resetPlayer() {
  mse = null;
  sb = null;
  queue = [];
  seekToLive = true;
  if (!videoEl) return;
  keepLastFrame(videoEl);
  videoEl.pause();
  videoEl.removeAttribute("src");
  videoEl.load();
}

/** Keep Alex's last frame on screen while paused or reconnecting, not a grey box. */
function keepLastFrame(v: HTMLVideoElement) {
  if (!v.videoWidth || v.readyState < 2) return;
  try {
    const c = document.createElement("canvas");
    c.width = 352;
    c.height = Math.round((v.videoHeight / v.videoWidth) * 352);
    c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
    v.poster = c.toDataURL("image/jpeg", 0.8);
  } catch {
    /* no still */
  }
}

function flush() {
  const v = videoEl;
  if (!v || !sb || sb.updating || !mse || mse.readyState !== "open") return;
  try {
    if (sb.buffered.length && v.currentTime - sb.buffered.start(0) > 30) {
      sb.remove(0, v.currentTime - 10); // the stream runs for the whole session: keep a short window
      return;
    }
    const next = queue.shift();
    if (next) sb.appendBuffer(next as BufferSource);
  } catch {
    fallbackToAudio();
  }
}

function openMse() {
  const v = videoEl;
  if (!MSE || !v) return;
  const src = new MSE();
  mse = src;
  v.src = URL.createObjectURL(src);
  src.addEventListener(
    "sourceopen",
    () => {
      if (mse !== src) return;
      try {
        sb = src.addSourceBuffer(codec);
      } catch {
        return fallbackToAudio();
      }
      sb.addEventListener("error", () => mse === src && fallbackToAudio());
      sb.addEventListener("updateend", () => {
        if (!sb || mse !== src) return;
        if (sb.buffered.length) {
          const end = sb.buffered.end(sb.buffered.length - 1);
          if (seekToLive || end - v.currentTime > 1.5) {
            v.currentTime = Math.max(0, end - 0.3); // stay near the live edge
            seekToLive = false;
          }
          if (v.paused) {
            v.muted = muted;
            v.play().catch(() => {
              v.muted = true; // sound blocked: picture still plays; captions carry the words
              v.play().catch(() => {});
            });
          }
        }
        flush();
      });
      flush();
    },
    { once: true },
  );
  queue.unshift(...initSeg);
}

function onVideoChunk(b64: string) {
  if (!MSE) return;
  lastVideoAt = Date.now();
  boxes = concat(boxes, fromBase64(b64));
  while (boxes.length >= 8) {
    const size = new DataView(boxes.buffer, boxes.byteOffset).getUint32(0);
    if (size < 8 || boxes.length < size) break;
    const box = boxes.slice(0, size);
    boxes = boxes.slice(size);
    const type = String.fromCharCode(...box.subarray(4, 8));
    if (type === "ftyp") {
      resetPlayer();
      initSeg = [box];
    } else if (type === "moov") {
      initSeg.push(box);
      for (let i = 4; i + 8 < box.length; i++) {
        if (String.fromCharCode(...box.subarray(i, i + 4)) === "avcC") {
          const profile = Array.from(box.subarray(i + 5, i + 8), (n) => n.toString(16).padStart(2, "0")).join("");
          codec = `video/mp4; codecs="avc1.${profile}, mp4a.40.2"`;
          break;
        }
      }
      if (!MSE.isTypeSupported(codec)) return fallbackToAudio();
    } else if (type === "moof") {
      moof = box;
    } else if (type === "mdat" && moof) {
      if (!mse && initSeg.length >= 2) openMse();
      queue.push(concat(moof, box));
      moof = null;
      flush();
    }
  }
}

function onAudioChunk(b64: string, mime: string) {
  if (muted || outputBlocked()) return;
  if (!outCtx) outCtx = new AudioContext();
  if (outCtx.state === "suspended") void outCtx.resume(); // never play into a suspended (silent) player
  const rate = parseInt((mime.match(/rate=(\d+)/) || [])[1] || "24000", 10);
  const bytes = fromBase64(b64);
  const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const buf = outCtx.createBuffer(1, pcm.length, rate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  const src = outCtx.createBufferSource();
  src.buffer = buf;
  src.connect(outCtx.destination);
  nextAudioTime = Math.max(nextAudioTime, outCtx.currentTime + 0.04);
  src.start(nextAudioTime);
  nextAudioTime += buf.duration;
  audioSources.add(src);
  src.onended = () => audioSources.delete(src);
}

function playbackRemaining(): number {
  let s = 0;
  if (videoEl && sb && sb.buffered.length) s = Math.max(0, sb.buffered.end(sb.buffered.length - 1) - videoEl.currentTime);
  if (outCtx) s = Math.max(s, nextAudioTime - outCtx.currentTime);
  return s;
}

function silence() {
  if (videoEl) videoEl.muted = true;
  audioSources.forEach((s) => {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  });
  audioSources.clear();
  nextAudioTime = 0;
}

function unmute() {
  if (videoEl && !muted && !outputBlocked()) videoEl.muted = false;
}

// ---- turns ----

function endTurn(result: PresentResult, delayMs: number) {
  const said = turnActive && spokenWords(alexLine).length > 0;
  turnActive = false;
  alexLine = "";
  const p = pending;
  pending = null;
  setTimeout(() => {
    handlers?.onSpeaking(false);
    if (said) handlers?.onTurnComplete();
    p?.resolve(result);
  }, delayMs);
}

/** A stopped turn is over: close its caption bubble (the next words start a new one). */
function endDroppedTurn() {
  const said = spokenWords(alexLine).length > 0;
  turnActive = false;
  alexLine = "";
  if (said) handlers?.onTurnComplete();
  setTimeout(unmute, 300);
}

function onMessage(msg: { type: string; [k: string]: unknown }) {
  switch (msg.type) {
    case "avatar_video":
      onVideoChunk(String(msg.data));
      break;
    case "audio":
      onAudioChunk(String(msg.data), String(msg.mime || ""));
      break;
    case "alex_text": {
      lastActivity = Date.now();
      if (outputBlocked()) {
        turnActive = true; // he is generating, just not heard: the turn's end still clears dropTurn
        break;
      }
      if (dropOldTurnUntil) {
        dropOldTurnUntil = 0; // the new line has started
        unmute();
      }
      if (!turnActive) {
        turnActive = true;
        userLine = "";
        unmute();
      }
      alexLine += String(msg.text);
      const words = spokenWords(alexLine);
      if (!words) break;
      handlers?.onSpeaking(true);
      handlers?.onCaption("alex", words);
      break;
    }
    case "user_text": {
      lastActivity = Date.now();
      lastUserTextAt = Date.now();
      userLine += String(msg.text);
      const said = spokenWords(userLine);
      if (said) handlers?.onCaption("user", said);
      break;
    }
    case "interrupted":
      if (dropTurn) {
        silence();
        dropTurn = false; // the cut-off turn is over
        endDroppedTurn();
        break;
      }
      // A fixed line he hasn't begun saying can't have been talked over: this is another turn's end.
      if (pending && !lineStarted()) break;
      silence();
      setTimeout(unmute, 500);
      if (!pending && isOldTurnEnd()) {
        turnActive = false;
        alexLine = "";
      } else {
        dropOldTurnUntil = Date.now() + 800; // the cut-off line's last caption pieces aren't shown
        endTurn("interrupted", 0); // the visitor talked over him
      }
      break;
    case "turn_complete":
      if (dropTurn) {
        dropTurn = false; // the rest of a stopped turn was dropped; Alex is quiet again
        endDroppedTurn();
        break;
      }
      if (pending) {
        // Done only if his transcript shows he said the line; otherwise it's another turn's end.
        if (lineSaid()) endTurn("done", Math.round(playbackRemaining() * 1000));
        else pending.sawEnd = true;
        break;
      }
      if (isOldTurnEnd()) {
        turnActive = false;
        alexLine = "";
      } else endTurn("done", Math.round(playbackRemaining() * 1000));
      break;
    case "tool_call": {
      lastActivity = Date.now();
      const calls = (msg.calls as { id: string; name: string; args: Record<string, unknown> }[]) ?? [];
      void Promise.all(
        calls.map(async (c) => {
          let response: Record<string, unknown> = { ok: true };
          try {
            response = (await handlers?.onToolCall(c.name, c.args ?? {})) ?? response;
          } catch {
            response = { ok: false, error: "the page couldn't do that" };
          }
          return { id: c.id, name: c.name, response };
        }),
      ).then((responses) => send({ type: "tool_response", responses }));
      break;
    }
    case "resume_handle":
      resumeHandle = String(msg.handle);
      break;
    case "go_away":
      void reconnect();
      break;
    case "unfaithful":
      handlers?.onUnfaithful();
      break;
  }
}

function send(obj: unknown) {
  if (isAlexConnected()) ws!.send(JSON.stringify(obj));
}

async function startMic(): Promise<boolean> {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch {
    return false; // no mic: Alex still works by typing
  }
  micCtx = new AudioContext({ sampleRate: 16000 });
  const srcNode = micCtx.createMediaStreamSource(micStream);
  // ponytail: ScriptProcessor is deprecated; move to an AudioWorklet if Chrome drops it
  const proc = micCtx.createScriptProcessor(4096, 1, 1);
  const sink = micCtx.createGain();
  sink.gain.value = 0;
  srcNode.connect(proc);
  proc.connect(sink);
  sink.connect(micCtx.destination);
  proc.onaudioprocess = (e) => {
    if (!isAlexConnected()) return;
    const f = e.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(f.length);
    if (micHeld) return void ws!.send(pcm.buffer); // on hold: Gemini hears silence
    for (let i = 0; i < f.length; i++) {
      const s = Math.max(-1, Math.min(1, f[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    ws!.send(pcm.buffer); // always stream: Gemini's voice detection is the barge-in
  };
  return true;
}

// ---- connection ----

function resetTurnState() {
  dropTurn = false;
  quietUntil = 0;
  turnActive = false;
  alexLine = "";
  selfInterruptUntil = 0;
  oldTurnOpen = false;
  pending?.resolve("closed");
  pending = null;
  silence();
  resetPlayer();
  initSeg = [];
  boxes = new Uint8Array();
  moof = null;
  handlers?.onSpeaking(false);
}

function openSocket(): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/alex");
    ws = sock;
    let ready = false;
    const lost = (reason: string) => {
      if (ws !== sock) return;
      if (!ready) {
        ws = null;
        reject(new Error(reason));
        return;
      }
      void reconnect();
    };
    // Never hang: a socket that doesn't become ready in 12 s counts as failed.
    setTimeout(() => !ready && ws === sock && (sock.close(), lost("timeout")), 12_000);
    sock.onopen = () =>
      sock.send(
        JSON.stringify({
          type: "setup",
          ...setupMsg,
          path: location.pathname + location.search,
          modality: forceAudio || !MSE ? "AUDIO" : undefined,
          resume_handle: resumeHandle ?? undefined,
        }),
      );
    sock.onerror = () => lost("unreachable");
    sock.onclose = () => lost("closed");
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      const msg = JSON.parse(String(ev.data));
      if (msg.type === "ready" && !ready) {
        ready = true;
        mode = msg.mode === "audio" ? "audio" : "video";
        lastVideoAt = Date.now();
        lastActivity = Date.now();
        handlers?.onMode(mode);
        resolve();
        return;
      }
      if (msg.type === "error" && !ready) {
        ws = null;
        sock.close();
        reject(new Error(String(msg.message || "failed")));
        return;
      }
      onMessage(msg);
    };
  });
}

function detachSocket() {
  const sock = ws;
  ws = null;
  if (!sock) return;
  sock.onclose = null;
  sock.onerror = null;
  sock.onmessage = null;
  if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: "end" }));
  sock.close();
}

async function reconnect() {
  if (reconnecting || !handlers) return;
  reconnecting = true;
  detachSocket();
  resetTurnState();
  for (let i = 0; i < RECONNECT_TRIES; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 1000 * 2 ** (i - 1)));
    if (!reconnecting) return;
    try {
      await openSocket();
      reconnecting = false;
      return;
    } catch {
      resumeHandle = null; // a stale handle can be refused: next try is a fresh conversation
    }
  }
  reconnecting = false;
  const h = handlers;
  closeAlex();
  h.onClosed("lost");
}

function fallbackToAudio() {
  if (forceAudio || mode === "audio" || !ws) return;
  forceAudio = true;
  void reconnect();
}

/** Video or voice only (the visitor's choice, the network, or the video budget). Keeps the conversation. */
export async function setAlexAudioOnly(audioOnly: boolean): Promise<void> {
  if (forceAudio === audioOnly) return;
  forceAudio = audioOnly;
  if (isAlexConnected()) await reconnect();
}

/** Text mode: Alex's words show as captions only, nothing is played. */
export function setAlexMuted(on: boolean): void {
  muted = on;
  if (on) silence();
  else unmute();
}

function watch() {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = setInterval(() => {
    if (!isAlexConnected() || reconnecting) return;
    if (mode === "video" && Date.now() - lastVideoAt > VIDEO_STALL_MS) return fallbackToAudio();
    const idle = Date.now() - lastActivity > SILENCE_PAUSE_MS && !turnActive && !pending;
    if (idle || document.visibilityState === "hidden") pauseAlex();
  }, 2000);
}

/** Close the stream but keep the conversation; resumeAlex() continues it. */
export function pauseAlex(): void {
  if (!isAlexConnected()) return;
  paused = true;
  detachSocket();
  resetTurnState();
  handlers?.onPaused();
}

export async function resumeAlex(): Promise<void> {
  if (!paused || isAlexConnected()) return;
  paused = false;
  await openSocket();
  lastActivity = Date.now();
}

/**
 * Start Alex (from a tap: browsers allow sound and the mic only then). Resolves once Gemini is
 * connected; `mic` is false when the microphone is blocked (the visitor can still type).
 */
export async function connectAlex(opts: { lang?: string; audioOnly: boolean }, h: AlexHandlers): Promise<{ mic: boolean }> {
  closeAlex();
  // Unlock audio now, inside the visitor's tap: if Alex later switches to voice only (budget used,
  // slow network, Voice chosen) his audio plays through this player, which Chrome would otherwise
  // start suspended (silent) when it's created later without a tap.
  if (!outCtx) outCtx = new AudioContext();
  void outCtx.resume();
  handlers = h;
  setupMsg = { path: "/", lang: opts.lang };
  resumeHandle = null;
  forceAudio = opts.audioOnly || !MSE;
  paused = false;
  try {
    await openSocket();
  } catch (e) {
    closeAlex();
    throw e;
  }
  const mic = await startMic();
  watch();
  return { mic };
}

/** Send Alex a text turn: the visitor's typed message, or an "APP:" note. */
export async function tellAlex(text: string): Promise<void> {
  if (paused) await resumeAlex();
  lastActivity = Date.now();
  send({ type: "text", text });
}

/** Have Alex say a fixed line ("SCRIPT: …"). Resolves when he has finished, was interrupted, or the session ended. */
export async function presentToAlex(line: string): Promise<PresentResult> {
  if (paused) await resumeAlex().catch(() => {});
  if (!isAlexConnected()) return "closed";
  quietUntil = 0;
  // A turn may still be open on Gemini's side: one we cut in on, or its own reply to what the
  // visitor just said ("skip"). Its end arrives right after this line is sent and isn't this line's.
  oldTurnOpen = turnActive || dropTurn || Date.now() - lastUserTextAt < 3000;
  if (turnActive) {
    silence(); // cut in on whatever he was still generating; drop its tail
    dropOldTurnUntil = Date.now() + 800;
  }
  dropTurn = false;
  turnActive = false;
  alexLine = ""; // from here on, his transcript is this line's
  userLine = ""; // what they say from now on is a new utterance
  pending?.resolve("closed");
  return new Promise((resolve) => {
    const mine: NonNullable<typeof pending> = { resolve, words: wordCount(line) };
    pending = mine;
    selfInterruptUntil = Date.now() + OLD_TURN_WINDOW_MS;
    lastActivity = Date.now();
    send({ type: "text", text: `SCRIPT: ${line}` });
    // If Gemini dropped the line (nothing said for 10 s), don't hang the tour: report it as cut off.
    const sentAt = Date.now();
    const stall = setInterval(() => {
      if (pending !== mine) return clearInterval(stall);
      // Quiet for a while: if he said part of it and a turn ended, take it as said (the transcript
      // can run short); if he never said it, report it as cut off so the tour presents it again.
      const quietFor = Date.now() - Math.max(sentAt, lastActivity);
      const partlySaid = mine.sawEnd && lineStarted();
      if (quietFor > 10_000) {
        clearInterval(stall);
        if (partlySaid) endTurn("done", 0);
        else {
          pending = null;
          resolve("interrupted");
        }
      }
    }, 1000);
  });
}

/**
 * Stop Alex's current speech (the visitor pressed stop / skip / pause). The rest of the turn he is
 * still generating is dropped (not played, not captioned) until Gemini ends it, so he doesn't carry
 * on after a short gap. Resolves a waiting line as "interrupted": the visitor stopped it, so nothing
 * else (such as the browser voice) should say it instead.
 */
export function hushAlex(): void {
  silence();
  if (turnActive) dropTurn = true;
  quietUntil = 0;
  pending?.resolve("stopped");
  pending = null;
}

/**
 * Hold (GCS): the mic sends silence, so nothing said in the room reaches Gemini, and nothing Alex
 * says is played or shown until released. Used by the tour's Pause and the Talk-mode Pause button.
 */
export function setAlexHold(on: boolean): void {
  micHeld = on;
  outputHeld = on;
  quietUntil = 0;
  if (on) {
    silence();
    if (turnActive) dropTurn = true;
    pending?.resolve("stopped");
    pending = null;
    handlers?.onSpeaking(false);
  } else unmute();
}

export const isAlexHeld = (): boolean => outputHeld;

/** After a tour line: keep Alex quiet until the next line (at most 8 s), so he doesn't add his own talk. */
export function quietAlexUntilNextLine(): void {
  quietUntil = Date.now() + QUIET_MAX_MS;
}

export function closeAlex(): void {
  reconnecting = false;
  paused = false;
  micHeld = false;
  outputHeld = false;
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
  detachSocket();
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  void micCtx?.close().catch(() => {});
  micCtx = null;
  resetTurnState();
  resumeHandle = null;
}
