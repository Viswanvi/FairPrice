import { beforeEach, describe, expect, it } from "vitest";
import {
  noteVideoFailure,
  startVideoTask,
  takeVideoTurn,
  turnVideoOff,
  VIDEO_SPARE_TURNS,
} from "@/app/_components/assistant/avatar";

// The video budget (AVATAR_SPEC section 6): n + 2 turns per task, then voice.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  globalThis.sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as Storage;
});

describe("video budget", () => {
  it("allows the task's turns plus two, then no more", () => {
    startVideoTask(2);
    for (let i = 0; i < 2 + VIDEO_SPARE_TURNS; i++) expect(takeVideoTurn()).toBe(true);
    expect(takeVideoTurn()).toBe(false);
  });

  it("starts fresh for the next task", () => {
    startVideoTask(1);
    while (takeVideoTurn()) {
      /* use it up */
    }
    startVideoTask(6);
    expect(takeVideoTurn()).toBe(true);
  });

  it("forgives one failure, turns video off on the second", () => {
    startVideoTask(5);
    expect(noteVideoFailure()).toBe(false);
    expect(takeVideoTurn()).toBe(true);
    expect(noteVideoFailure()).toBe(true);
    expect(takeVideoTurn()).toBe(false);
  });

  it("stays off after an unfaithful reading, even for a new task", () => {
    startVideoTask(5);
    turnVideoOff();
    startVideoTask(5);
    expect(takeVideoTurn()).toBe(false);
  });

  it("stops after 5 minutes of video in the session", () => {
    store.set("fp_avatar_budget_v1", JSON.stringify({ left: 10, usedMs: 5 * 60_000, off: false }));
    expect(takeVideoTurn()).toBe(false);
  });
});
