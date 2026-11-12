/**
 * When Alex may use video, and how much of it (AVATAR_SPEC section 6). Pure browser state in
 * sessionStorage; Alex itself is in ./alex.ts.
 */

// ---- When: a fast connection only ----

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

function mediaSourceSupported(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.MediaSource ?? (window as Window & { ManagedMediaSource?: unknown }).ManagedMediaSource);
}

// ---- How much: n + 2 turns per task, 5 minutes per browser session ----

const BUDGET_KEY = "fp_avatar_budget_v1";
export const VIDEO_MAX_MS = 5 * 60_000;
/** Extra video turns allowed beyond what a task is expected to need. */
export const VIDEO_SPARE_TURNS = 2;

interface Budget {
  /** Video turns left in the current task. */
  left: number;
  /** Video streamed this browser session, in ms. */
  usedMs: number;
  /** Set after an unfaithful reading: voice for the rest of the session. */
  off: boolean;
  /** Failed video starts this session (one blip is forgiven). */
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
    /* storage unavailable: the budget resets on reload; the server's session limits still apply */
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
  return !b.off && b.usedMs < VIDEO_MAX_MS && videoNetworkOk() && mediaSourceSupported();
}

/** Voice only for the rest of this browser session. */
export function turnVideoOff(): void {
  writeBudget({ ...readBudget(), off: true });
}

/** Video failed to start: returns true when video is now off (second failure). */
export function noteVideoFailure(): boolean {
  const b = readBudget();
  const fails = (b.fails ?? 0) + 1;
  writeBudget({ ...b, fails, off: b.off || fails >= 2 });
  return fails >= 2;
}

/** Count streamed video time towards the 5-minute cap. */
export function addVideoMs(ms: number): void {
  const b = readBudget();
  writeBudget({ ...b, usedMs: b.usedMs + Math.max(0, ms) });
}
