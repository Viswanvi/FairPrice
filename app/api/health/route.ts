import { prisma } from "@/lib/db/client";
import { checkHealth } from "@/lib/health";

// Never prerender or cache: every call must really reach the database.
export const dynamic = "force-dynamic";

/** GET /api/health — Render's health check: the app is up and can reach Postgres. */
export async function GET(): Promise<Response> {
  const { status, body } = await checkHealth(() => prisma.$queryRaw`SELECT 1`);
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
