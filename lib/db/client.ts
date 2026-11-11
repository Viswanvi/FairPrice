import { PrismaClient, type Prisma } from "@prisma/client";

/** Either the shared client or a transaction client, so helpers can join a caller's transaction. */
export type Db = PrismaClient | Prisma.TransactionClient;

/**
 * One Prisma client per process. In development Next.js hot-reloads modules, so the client
 * is cached on globalThis to avoid opening a new connection pool on every reload.
 * Only warnings and errors are logged — never queries, which could contain IDs or payloads.
 */
const globalForPrisma = globalThis as unknown as { fairpricePrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.fairpricePrisma ?? new PrismaClient({ log: ["warn", "error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.fairpricePrisma = prisma;
