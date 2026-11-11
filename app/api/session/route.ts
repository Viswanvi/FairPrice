import { z } from "zod";
import { signIn, signOut } from "@/lib/auth/session";
import { HttpError, readJson, route } from "@/lib/http";

const bodySchema = z.object({ password: z.string().max(200) });

/** Seller sign-in with the demo password. */
export const POST = route(async (request: Request) => {
  const { password } = await readJson(request, bodySchema);
  if (!(await signIn(password))) {
    throw new HttpError(401, "invalid_password", "That password isn't right.");
  }
  return Response.json({ ok: true });
});

/** Sign out. */
export const DELETE = route(async () => {
  await signOut();
  return Response.json({ ok: true });
});
