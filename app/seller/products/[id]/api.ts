/** Tiny fetch wrapper for the seller screens: JSON in, `{ ok, status, data }` out, never throws. */
export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T & { code?: string; message?: string; reasons?: unknown };
}

export async function callApi<T = Record<string, unknown>>(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as ApiResult<T>["data"];
    return { ok: res.ok, status: res.status, data };
  } catch {
    return {
      ok: false,
      status: 0,
      data: { message: "We couldn't reach the server. Check your connection and try again." } as ApiResult<T>["data"],
    };
  }
}
