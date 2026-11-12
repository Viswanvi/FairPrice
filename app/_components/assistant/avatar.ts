/**
 * The video avatar in the browser: when to use it, how much of it, and playing what it says.
 *
 * It only ever reads text FairPrice already has (the assistant's reply, a tour line, a payment
 * result): POST /api/avatar/speak opens a short Gemini session on the server and streams back
 * fragmented MP4 (video with its audio), played here through Media Source Extensions. One turn
 * at a time; nothing streams while the avatar is silent. Any failure returns "failed" and the
 * caller speaks with the browser voice instead (spec section 6: video → voice → text).
 */

export type SpeakOutcome = "done" | "stopped" | "failed" | "unfaithful";

// ---- When: a fast connection only (AVATAR_SPEC section 6) ----

interface NetworkInformationLike {
  effectiveType?: string;
  downlink?: number;
  saveData?: boolean;
}

/** Video only when the browser reports 4g, at least 5 Mbps and no data saver; unknown means no. */
export function videoNetworkOk(): boolean {
  if (typeof navigator === "undefined") return false;
  const c = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (!c) return false; // Safari and Firefox can't tell
  return c.effectiveType === "4g" && (c.downlink ?? 0) >= 5 && !c.saveData;
}

function mediaSource(): typeof MediaSource | undefined {
  if (typeof window === "undefined") return undefined;
  return window.MediaSource ?? (window as Window & { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
}

// ---- How much: n + 2 turns per task, 5 minutes per browser session ----

const BUDGET_KEY = "fp_avatar_budget_v1";
export const VIDEO_MAX_MS = 5 * 60_000;
/** Extra video turns allowed beyond what a task is expected to need. */
export const VIDEO_SPARE_TURNS = 2;

interface Budget {
  /** Video turns left in the current task. */
  left: number;
  /** Video played this browser session, in ms. */
  usedMs: number;
  /** Set after a second failure or an unfaithful reading: voice for the rest of the session. */
  off: boolean;
  /** Failed video turns this session (Gemini sometimes drops a session; one blip is forgiven). */
  fails?: number;
}

function readBudget(): Budget {
  try {
    const raw = sessionStorage.getItem(BUDGET_KEY);
    if (raw) return JSON.parse(raw) as Budget;
  } catch {
    /* storage unavailable */
  }
  return { left: 0, usedMs: 0, off: false };
}

function writeBudget(b: Budget): void {
  try {
    sessionStorage.setItem(BUDGET_KEY, JSON.stringify(b));
  } catch {
    /* storage unavailable: the budget resets on reload, the server rate limit still applies */
  }
}

/** A new task starts: allow video for its expected turns (n) plus the spare ones. */
export function startVideoTask(expectedTurns: number): void {
  writeBudget({ ...readBudget(), left: expectedTurns + VIDEO_SPARE_TURNS });
}

/** True when a video turn may be used now (and counts it). */
export function takeVideoTurn(): boolean {
  const b = readBudget();
  if (b.off || b.left <= 0 || b.usedMs >= VIDEO_MAX_MS) return false;
  writeBudget({ ...b, left: b.left - 1 });
  return true;
}

export function videoTurnsLeft(): number {
  return readBudget().left;
}

export function videoAvailable(): boolean {
  const b = readBudget();
  return !b.off && b.usedMs < VIDEO_MAX_MS && videoNetworkOk() && Boolean(mediaSource());
}

/** Voice only for the rest of this browser session (after an unfaithful reading). */
export function turnVideoOff(): void {
  writeBudget({ ...readBudget(), off: true });
}

/** A video turn failed: that turn uses voice. Returns true when video is now off (second failure). */
export function noteVideoFailure(): boolean {
  const b = readBudget();
  const fails = (b.fails ?? 0) + 1;
  writeBudget({ ...b, fails, off: b.off || fails >= 2 });
  return fails >= 2;
}

function addVideoMs(ms: number): void {
  const b = readBudget();
  writeBudget({ ...b, usedMs: b.usedMs + Math.max(0, ms) });
}

// ---- Playing: one fragmented-MP4 stream per turn ----

let videoEl: HTMLVideoElement | null = null;
let current: { finish: (o: SpeakOutcome) => void } | null = null;

/** The panel's <video>; the avatar draws into it. */
export function attachAvatarVideo(el: HTMLVideoElement | null): void {
  videoEl = el;
  if (el && !el.poster) {
    try {
      el.poster = sessionStorage.getItem(POSTER_KEY) ?? "";
    } catch {
      /* storage unavailable: grey until the first frame */
    }
  }
}

const POSTER_KEY = "fp_avatar_poster";

/** Keep the avatar's last frame on screen between turns (as the video's poster), not a grey box. */
function keepLastFrame(video: HTMLVideoElement): void {
  if (!video.videoWidth || video.readyState < 2) return;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 352; // half size is plenty for a still in a 380px panel
    canvas.height = Math.round((video.videoHeight / video.videoWidth) * 352);
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const still = canvas.toDataURL("image/jpeg", 0.8);
    video.poster = still;
    sessionStorage.setItem(POSTER_KEY, still);
  } catch {
    /* no still: the box is grey until the next frame */
  }
}

/** Stop the avatar now (visitor tapped stop, the tab was hidden, or a new turn starts). */
export function avatarStop(): void {
  current?.finish("stopped");
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const r = new Uint8Array(a.length + b.length);
  r.set(a);
  r.set(b, a.length);
  return r;
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/**
 * Read `text` aloud as the avatar. Resolves when it has finished playing ("done"), was stopped,
 * failed (caller falls back to voice), or was "unfaithful" (it said a number the text didn't
 * have: the caller turns video off for the session).
 */
export async function avatarSpeak(text: string, onPlaying?: () => void): Promise<SpeakOutcome> {
  avatarStop();
  const MSE = mediaSource();
  // The panel may mount in the same tap that starts the first turn: give it a moment.
  for (let i = 0; !videoEl && i < 15; i++) await new Promise((r) => setTimeout(r, 100));
  const v = videoEl;
  if (!MSE || !v) return "failed";
  const video: HTMLVideoElement = v;

  return new Promise<SpeakOutcome>((resolve) => {
    const abort = new AbortController();
    let settled = false;
    let started = 0;
    let mse: MediaSource | null = null;
    let sb: SourceBuffer | null = null;
    let boxes: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let init: Uint8Array[] = [];
    let moof: Uint8Array | null = null;
    const queue: Uint8Array[] = [];
    let streamDone = false;
    let faithful = true;
    let endTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (outcome: SpeakOutcome) => {
      if (settled) return;
      settled = true;
      if (current?.finish === finish) current = null;
      abort.abort();
      if (endTimer) clearTimeout(endTimer);
      if (started) addVideoMs(Date.now() - started);
      video.onended = null;
      video.pause();
      keepLastFrame(video);
      // Once the visitor has heard the avatar start a line, nothing may say it again: a cut-off or
      // a late failure counts as "done" (the full text is on screen). Otherwise the voice fallback
      // would repeat the whole line and the visitor hears it twice.
      resolve(started && (outcome === "failed" || outcome === "stopped") ? "done" : outcome);
    };
    current = { finish };

    const endIfDrained = () => {
      if (!streamDone || !mse || !sb || sb.updating || queue.length > 0 || mse.readyState !== "open") return;
      try {
        mse.endOfStream();
      } catch {
        /* already ended */
      }
      // 'ended' should fire; this is the safety net if it doesn't.
      const left = sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) - video.currentTime : 0;
      endTimer = setTimeout(() => finish(faithful ? "done" : "unfaithful"), Math.max(0, left) * 1000 + 1500);
    };

    const flush = () => {
      if (!sb || sb.updating || !mse || mse.readyState !== "open") return;
      const next = queue.shift();
      if (!next) return endIfDrained();
      try {
        sb.appendBuffer(next as BufferSource);
      } catch {
        finish("failed");
      }
    };

    const open = (codec: string) => {
      const src = new MSE();
      mse = src;
      keepLastFrame(video); // the old frame stays up while the new turn loads
      video.src = URL.createObjectURL(src);
      src.addEventListener(
        "sourceopen",
        () => {
          try {
            sb = src.addSourceBuffer(codec);
          } catch {
            return finish("failed");
          }
          sb.addEventListener("error", () => finish("failed"));
          sb.addEventListener("updateend", () => {
            // Start once about a second is buffered (or the turn is complete), so it doesn't stutter.
            const ahead = sb && sb.buffered.length ? sb.buffered.end(sb.buffered.length - 1) - video.currentTime : 0;
            if (video.paused && !settled && (ahead >= 1 || streamDone)) {
              video.muted = false;
              video
                .play()
                .then(() => {
                  if (!started) {
                    started = Date.now();
                    onPlaying?.();
                  }
                })
                .catch(() => finish("failed")); // sound blocked: the caller uses voice/text
            }
            flush();
          });
          flush();
        },
        { once: true },
      );
      queue.unshift(...init);
    };

    const onVideo = (b64: string) => {
      boxes = concat(boxes, fromBase64(b64));
      while (boxes.length >= 8) {
        const size = new DataView(boxes.buffer, boxes.byteOffset).getUint32(0);
        if (size < 8 || boxes.length < size) break;
        const box = boxes.slice(0, size);
        boxes = boxes.slice(size);
        const type = String.fromCharCode(...box.subarray(4, 8));
        if (type === "ftyp") {
          init = [box];
        } else if (type === "moov") {
          init.push(box);
          let codec = 'video/mp4; codecs="avc1.42c020, mp4a.40.2"';
          for (let i = 4; i + 8 < box.length; i++) {
            if (String.fromCharCode(...box.subarray(i, i + 4)) === "avcC") {
              const profile = Array.from(box.subarray(i + 5, i + 8), (n) => n.toString(16).padStart(2, "0")).join("");
              codec = `video/mp4; codecs="avc1.${profile}, mp4a.40.2"`;
              break;
            }
          }
          if (!MSE.isTypeSupported(codec)) return finish("failed");
          if (!mse) open(codec);
        } else if (type === "moof") {
          moof = box;
        } else if (type === "mdat" && moof) {
          queue.push(concat(moof, box));
          moof = null;
          flush();
        }
      }
    };

    video.onended = () => finish(faithful ? "done" : "unfaithful");

    void (async () => {
      try {
        const res = await fetch("/api/avatar/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) return finish("failed");
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffered = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffered += value;
          let nl: number;
          while ((nl = buffered.indexOf("\n")) >= 0) {
            const line = buffered.slice(0, nl);
            buffered = buffered.slice(nl + 1);
            if (!line) continue;
            const msg = JSON.parse(line) as { t: string; d?: string; faithful?: boolean };
            if (msg.t === "video" && msg.d) onVideo(msg.d);
            else if (msg.t === "error") return finish("failed");
            else if (msg.t === "done") {
              faithful = msg.faithful !== false;
              streamDone = true;
              if (!mse) return finish("failed"); // no video arrived
              flush();
            }
          }
        }
        if (!streamDone) finish("failed");
      } catch {
        finish(settled ? "stopped" : "failed");
      }
    })();
  });
}
