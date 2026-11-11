import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { DEMO_SELLER_ID } from "@/lib/db/demo";
import { env } from "@/lib/env";
import { HttpError } from "@/lib/http";
import { createSessionToken, passwordMatches, SESSION_TTL_SECONDS, verifySessionToken } from "./session-token";

/** Demo seller sign-in: one password (SELLER_DEMO_PASSWORD), httpOnly cookie signed with SESSION_SECRET. */

const COOKIE = "fp_session";

export async function signIn(password: string): Promise<boolean> {
  if (!passwordMatches(password, env.SELLER_DEMO_PASSWORD)) return false;
  (await cookies()).set(COOKIE, createSessionToken(DEMO_SELLER_ID, Date.now(), env.SESSION_SECRET), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return true;
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/** The signed-in seller's ID, or null. */
export async function currentSellerId(): Promise<string | null> {
  return verifySessionToken((await cookies()).get(COOKIE)?.value, Date.now(), env.SESSION_SECRET);
}

/** For seller pages: the signed-in seller's ID, or a redirect to the sign-in page. */
export async function requireSellerPage(): Promise<string> {
  const sellerId = await currentSellerId();
  if (!sellerId) redirect("/seller/sign-in");
  return sellerId;
}

/** The signed-in seller's ID, or a 401 HttpError. */
export async function requireSeller(): Promise<string> {
  const sellerId = await currentSellerId();
  if (!sellerId) throw new HttpError(401, "unauthorized", "Please sign in first.");
  return sellerId;
}
