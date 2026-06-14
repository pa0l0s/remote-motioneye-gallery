import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

/**
 * SQLite tuning for a single-writer background indexer plus concurrent API reads:
 * WAL lets readers proceed during writes; busy_timeout waits out brief lock contention
 * instead of failing with "database is locked".
 */
export async function initDb(): Promise<void> {
  await prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL;");
  await prisma.$executeRawUnsafe("PRAGMA busy_timeout=10000;");
  await prisma.$executeRawUnsafe("PRAGMA synchronous=NORMAL;");
}
