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
export type PresentResult = "done" | "interrupted" | "closed";

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

let turnActive = false;
let alexLine = "";
let userLine = "";
let pending: { resolve: (r: PresentResult) => void } | null = null;
// A new SCRIPT cuts in on whatever Alex was still generating; that old turn's 'interrupted' /
// 'turn_complete' arrive just after and must not end the new one.
// ponytail: time window, track turn ids if Gemini ever exposes them
const OLD_TURN_WINDOW_MS = 1500;
let selfInterruptUntil = 0;

const spokenWords = (s: string) => s.replace(/<[a-z][^>]*(>|$)/gi, "").replace(/\{[a-z][^}]*(\}|$)/gi, "").trim();

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
  if (muted) return;
  if (!outCtx) outCtx = new AudioContext();
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
  if (videoEl && !muted) videoEl.muted = false;
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
      userLine += String(msg.text);
      const said = spokenWords(userLine);
      if (said) handlers?.onCaption("user", said);
      break;
    }
    case "interrupted":
      silence();
      setTimeout(unmute, 500);
      if (Date.now() < selfInterruptUntil) {
        turnActive = false;
        alexLine = "";
      } else endTurn("interrupted", 0);
      break;
    case "turn_complete":
      if (Date.now() < selfInterruptUntil && !pending) {
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
  turnActive = false;
  alexLine = "";
  selfInterruptUntil = 0;
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
  if (turnActive) silence();
  pending?.resolve("closed");
  return new Promise((resolve) => {
    pending = { resolve };
    selfInterruptUntil = Date.now() + OLD_TURN_WINDOW_MS;
    lastActivity = Date.now();
    send({ type: "text", text: `SCRIPT: ${line}` });
  });
}

/** Stop Alex's current speech (the visitor pressed stop / skip). */
export function hushAlex(): void {
  silence();
  if (turnActive) selfInterruptUntil = Date.now() + OLD_TURN_WINDOW_MS;
  pending?.resolve("closed");
  pending = null;
  setTimeout(unmute, 600);
}

export function closeAlex(): void {
  reconnecting = false;
  paused = false;
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
