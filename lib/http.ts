import { z } from "zod";

/**
 * Small helpers for API routes. Every error response is `{ code, message }` (plus optional
 * details) and never includes a stack trace (docs/SPEC.md section 9).
 */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function jsonError(status: number, code: string, message: string, details?: Record<string, unknown>): Response {
  return Response.json({ code, message, ...details }, { status });
}

/** Parse and validate a JSON body; throws a 400 HttpError naming the first problem. */
export async function readJson<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "invalid_json", "The request body must be JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw new HttpError(400, "invalid_request", field ? `${field}: ${issue.message}` : (issue?.message ?? "Invalid request."));
  }
  return parsed.data;
}

/**
 * Wrap a route handler: HttpErrors become their JSON response; anything else is logged
 * (name and message only) and returned as a generic 500.
 */
export function route<C>(handler: (request: Request, context: C) => Promise<Response>) {
  return async (request: Request, context: C): Promise<Response> => {
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof HttpError) return jsonError(error.status, error.code, error.message, error.details);
      console.error("[api]", error instanceof Error ? `${error.name}: ${error.message}` : "unknown error");
      return jsonError(500, "internal_error", "Something went wrong on our side. Please try again.");
    }
  };
}
