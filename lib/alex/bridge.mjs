/**
 * Alex bridge: the browser ⇄ Gemini Live (Vertex AI, video avatar), at /ws/alex. Ported from the
 * GCS "Alex" server (alexServer.js), with FairPrice's safety rules:
 *
 * - Alex's instruction and tools come from POST /api/alex/setup (the assistant's own rules and
 *   tools), fetched here on the server with the visitor's cookie; the browser can't change them.
 * - Only same-origin pages may connect, sessions are limited per IP, and each one has a time cap.
 * - The Google key stays on the server.
 * - Faithfulness: every number Alex says must have come from a tool result, the visitor, the
 *   app's own text or the instruction; otherwise the browser is told ("unfaithful") and logs it.
 *
 * Browser → bridge: {"type":"setup", path, lang?, modality?: "AUDIO", resume_handle?} first, then raw
 * PCM16 mic audio (16 kHz), {"type":"text", text} and {"type":"tool_response", responses}.
 * Bridge → browser: ready {mode}, avatar_video / audio chunks, alex_text / user_text captions,
 * interrupted, turn_complete, tool_call, resume_handle, go_away, unfaithful, error.
 *
 * Plain JS (not TypeScript) because it runs inside server.mjs, outside Next's bundler.
 */

import { WebSocketServer } from "ws";
import { ActivityHandling, GoogleGenAI, Modality, StartSensitivity } from "@google/genai";
import { numbersIn } from "../avatar/numbers.mjs";

const SESSION_MAX_MS = 20 * 60_000;
const SESSIONS_PER_IP = 12; // per 30 minutes
const WINDOW_MS = 30 * 60_000;

const wss = new WebSocketServer({ noServer: true });
const starts = new Map(); // ip → session start times

function clientIp(req) {
  return String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

function allowSession(ip) {
  const now = Date.now();
  const recent = (starts.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= SESSIONS_PER_IP) return false;
  recent.push(now);
  starts.set(ip, recent);
  return true;
}

/** Only pages of this site may open Alex (a WebSocket isn't covered by the same-origin policy). */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function configured() {
  return Boolean(process.env.GOOGLE_API_KEY && process.env.GOOGLE_CLOUD_PROJECT);
}

/** Handles the upgrade if it is for /ws/alex; returns false so other upgrades (Next's HMR) go on. */
export function handleAlexUpgrade(req, socket, head, port) {
  if (!req.url?.startsWith("/ws/alex")) return false;
  if (!sameOrigin(req) || !allowSession(clientIp(req))) {
    socket.destroy();
    return true;
  }
  wss.handleUpgrade(req, socket, head, (ws) => runSession(ws, req, port));
  return true;
}

async function fetchSetup(req, port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/alex/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-alex-bridge": process.env.SESSION_SECRET ?? "",
      cookie: req.headers.cookie ?? "",
      "x-forwarded-for": clientIp(req),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`setup ${res.status}`);
  return res.json();
}

function liveConfig(setup, useVideo, resumeHandle) {
  return {
    responseModalities: [useVideo ? Modality.VIDEO : Modality.AUDIO],
    avatarConfig: useVideo ? { avatarName: process.env.AVATAR_NAME || "Jay", videoBitrateBps: 500_000 } : undefined,
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.AVATAR_VOICE || "Charon" } } },
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: resumeHandle ? { handle: String(resumeHandle) } : {},
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
      automaticActivityDetection: { startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH, prefixPaddingMs: 20 },
    },
    systemInstruction: { parts: [{ text: setup.system }] },
    tools: [{ functionDeclarations: setup.tools }],
  };
}

function runSession(browser, req, port) {
  const send = (msg) => browser.readyState === 1 && browser.send(JSON.stringify(msg));
  if (!configured()) {
    send({ type: "error", message: "avatar_unavailable" });
    browser.close();
    return;
  }

  let live = null;
  let starting = false;
  let closingByUs = false;
  const allowed = new Set(); // numbers Alex may say
  const allow = (text) => numbersIn(text).forEach((n) => allowed.add(n));
  let alexLine = "";
  const capTimer = setTimeout(() => {
    send({ type: "error", message: "session_time_limit" });
    browser.close();
  }, SESSION_MAX_MS);

  const checkTurn = () => {
    const extra = numbersIn(alexLine).filter((n) => !allowed.has(n));
    if (extra.length) {
      console.error("[alex] said a number no tool, visitor or app text gave it"); // no text logged
      send({ type: "unfaithful" });
    }
    alexLine = "";
  };

  const forward = (m) => {
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) {
      send({ type: "resume_handle", handle: m.sessionResumptionUpdate.newHandle });
    }
    if (m.goAway) send({ type: "go_away" });
    const calls = m.toolCall?.functionCalls;
    if (calls?.length) send({ type: "tool_call", calls: calls.map((c) => ({ id: c.id, name: c.name, args: c.args ?? {} })) });
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.interrupted) send({ type: "interrupted" });
    if (sc.inputTranscription?.text) {
      allow(sc.inputTranscription.text);
      send({ type: "user_text", text: sc.inputTranscription.text });
    }
    if (sc.outputTranscription?.text) {
      alexLine += sc.outputTranscription.text;
      send({ type: "alex_text", text: sc.outputTranscription.text });
    }
    if (sc.modelTurn && !sc.interrupted) {
      for (const part of sc.modelTurn.parts ?? []) {
        const d = part.inlineData;
        if (!d?.data) continue;
        const mime = d.mimeType || "audio/pcm;rate=24000";
        send({ type: mime.startsWith("video/") ? "avatar_video" : "audio", data: d.data, mime });
      }
    }
    if (sc.turnComplete) {
      checkTurn();
      send({ type: "turn_complete" });
    }
  };

  async function connect(msg) {
    const setup = await fetchSetup(req, port, { path: String(msg.path || "/"), lang: msg.lang });
    allow(setup.system);
    const ai = new GoogleGenAI({
      vertexai: true,
      apiKey: process.env.GOOGLE_API_KEY,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION || "us-central1",
    });
    const wantVideo = String(msg.modality || "").toUpperCase() !== "AUDIO";
    const open = (useVideo) =>
      ai.live.connect({
        model: process.env.AVATAR_LIVE_MODEL || "gemini-3.8-live",
        config: liveConfig(setup, useVideo, msg.resume_handle),
        callbacks: {
          onmessage: forward,
          onerror: (e) => {
            console.error("[alex] Gemini error:", e?.message ?? "unknown");
            send({ type: "error", message: "gemini_error" });
          },
          onclose: (e) => {
            if (closingByUs) return;
            console.warn("[alex] Gemini closed the session", e?.code);
            send({ type: "error", message: `closed ${e?.code ?? ""}`.trim() });
            browser.close();
          },
        },
      });
    if (!wantVideo) return { session: await open(false), mode: "audio" };
    try {
      return { session: await open(true), mode: "video" };
    } catch (err) {
      console.warn("[alex] video connect failed, voice only:", err?.name ?? "error");
      return { session: await open(false), mode: "audio" };
    }
  }

  browser.on("message", async (data, isBinary) => {
    if (isBinary) {
      if (live) live.sendRealtimeInput({ audio: { data: Buffer.from(data).toString("base64"), mimeType: "audio/pcm;rate=16000" } });
      return;
    }
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.type === "setup" && !live && !starting) {
      starting = true;
      try {
        const { session, mode } = await connect(msg);
        live = session;
        if (browser.readyState !== 1) return live.close();
        send({ type: "ready", mode });
      } catch (err) {
        console.error("[alex] connect failed:", err?.name ?? "error", err?.message?.slice(0, 80) ?? "");
        send({ type: "error", message: "connect_failed" });
        browser.close();
      }
      return;
    }
    if (!live) return;
    if (msg.type === "text") {
      const text = String(msg.text || "").slice(0, 2000);
      allow(text);
      live.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
    } else if (msg.type === "tool_response") {
      const responses = (msg.responses || []).map((r) => ({ id: r.id, name: r.name, response: r.response || { ok: true } }));
      allow(JSON.stringify(responses));
      live.sendToolResponse({ functionResponses: responses });
    } else if (msg.type === "end") {
      browser.close();
    }
  });

  browser.on("close", () => {
    closingByUs = true;
    clearTimeout(capTimer);
    if (live) live.close();
  });
}
