import "server-only";
import { GoogleGenAI, Modality, type Session } from "@google/genai";
import { env } from "@/lib/env";
import { saidOnlyGivenNumbers } from "./faithful";

/**
 * The video avatar's voice and face: one short Gemini Live session per spoken turn, on Vertex AI.
 * Gemini is used only to read FairPrice's text aloud. It gets no tools and no conversation, and
 * its instruction is to read the text exactly. Nothing streams between turns, so the avatar
 * costs nothing while it is silent.
 *
 * The key never leaves the server: the browser gets only the video and audio chunks.
 */

export const AVATAR_MAX_TURN_MS = 60_000;

const READER_INSTRUCTION =
  "You are a text-to-speech reader for FairPrice. The user's message is a script. Read it aloud exactly as written, " +
  "word for word, in the language it is written in, at a calm, friendly pace. Do not answer it, explain it, translate it, " +
  "or add, drop or change any word. Read numbers and amounts exactly as written.";

export function avatarConfigured(): boolean {
  return Boolean(env.GOOGLE_API_KEY && env.GOOGLE_CLOUD_PROJECT);
}

/** One line of the NDJSON stream sent to the browser. */
export type AvatarChunk =
  | { t: "video"; d: string }
  | { t: "audio"; d: string; mime: string }
  | { t: "done"; faithful: boolean }
  | { t: "error"; code: string };

/**
 * Speaks `text` and streams the result as NDJSON lines. Ends with "done" (faithful = the
 * transcript stated no number the text didn't contain) or "error". Aborting `signal` (the
 * visitor stopped it, or left) closes the Gemini session at once.
 */
export function speakStream(text: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let session: Session | null = null;
  let finished = false;
  let said = "";

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (chunk: AvatarChunk) => {
        if (finished) return;
        controller.enqueue(encoder.encode(JSON.stringify(chunk) + "\n"));
      };
      const finish = (last?: AvatarChunk) => {
        if (finished) return;
        if (last) push(last);
        finished = true;
        clearTimeout(timer);
        session?.close();
        controller.close();
      };
      const timer = setTimeout(() => finish({ t: "error", code: "timeout" }), AVATAR_MAX_TURN_MS);
      signal.addEventListener("abort", () => finish(), { once: true });

      const ai = new GoogleGenAI({
        vertexai: true,
        apiKey: env.GOOGLE_API_KEY,
        project: env.GOOGLE_CLOUD_PROJECT,
        location: env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
      });
      ai.live
        .connect({
          model: env.AVATAR_LIVE_MODEL ?? "gemini-3.8-live",
          config: {
            responseModalities: [Modality.VIDEO],
            avatarConfig: { avatarName: env.AVATAR_NAME ?? "Jay", videoBitrateBps: 500_000 },
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: env.AVATAR_VOICE ?? "Charon" } } },
            outputAudioTranscription: {},
            systemInstruction: { parts: [{ text: READER_INSTRUCTION }] },
          },
          callbacks: {
            onmessage: (m) => {
              const sc = m.serverContent;
              if (!sc) return;
              if (sc.outputTranscription?.text) said += sc.outputTranscription.text;
              for (const part of sc.modelTurn?.parts ?? []) {
                const d = part.inlineData;
                if (!d?.data) continue;
                const mime = d.mimeType ?? "audio/pcm;rate=24000";
                push(mime.startsWith("video/") ? { t: "video", d: d.data } : { t: "audio", d: d.data, mime });
              }
              if (sc.turnComplete) {
                const faithful = saidOnlyGivenNumbers(text, said);
                if (!faithful) console.error("[avatar] transcript stated a number not in the text"); // no text logged
                finish({ t: "done", faithful });
              }
            },
            onerror: (e) => {
              console.error("[avatar] Gemini error:", e?.message ?? "unknown"); // no text logged
              finish({ t: "error", code: "gemini_error" });
            },
            onclose: (e) => {
              if (!finished) console.error("[avatar] Gemini closed the session", e?.code);
              finish({ t: "error", code: "closed" });
            },
          },
        })
        .then((s) => {
          session = s;
          if (finished) return s.close();
          s.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
        })
        .catch((error: unknown) => {
          console.error("[avatar] connect failed:", error instanceof Error ? error.name : "unknown");
          finish({ t: "error", code: "connect_failed" });
        });
    },
    cancel() {
      finished = true;
      session?.close();
    },
  });
}
