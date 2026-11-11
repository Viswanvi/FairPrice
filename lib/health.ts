/**
 * Health check for GET /api/health (Render's health check path). Pure apart from the injected
 * database ping, so it can be tested without a database.
 */

export type HealthBody = { ok: boolean; db: boolean };
export type HealthResult = { status: 200 | 503; body: HealthBody };

/** Render waits a few seconds for a health check; answer before it gives up. */
export const DB_PING_TIMEOUT_MS = 3_000;

class PingTimeoutError extends Error {
  constructor() {
    super("database ping timed out");
    this.name = "PingTimeoutError";
  }
}

/**
 * Ping the database once. Any error, or no answer within the timeout, counts as down.
 * Logs only the error's name: database errors can name hosts or connection details.
 */
export async function checkHealth(
  ping: () => Promise<unknown>,
  timeoutMs: number = DB_PING_TIMEOUT_MS,
): Promise<HealthResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PingTimeoutError()), timeoutMs);
  });
  try {
    await Promise.race([ping(), timeout]);
    return { status: 200, body: { ok: true, db: true } };
  } catch (error) {
    console.error("[health] database check failed:", error instanceof Error ? error.name : "unknown error");
    return { status: 503, body: { ok: false, db: false } };
  } finally {
    clearTimeout(timer);
  }
}
