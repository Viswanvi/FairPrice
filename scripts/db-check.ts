// Checks that DATABASE_URL is reachable. Run with `npm run db:check`.
import { PrismaClient } from "@prisma/client";
import { env } from "../lib/env.script";

async function main(): Promise<void> {
  const host = new URL(env.DATABASE_URL).hostname;
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw<{ version: string }[]>`SELECT version()`;
    console.log(`Database OK (${host}): ${rows[0]?.version.split(",")[0] ?? "unknown version"}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("Database check failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
