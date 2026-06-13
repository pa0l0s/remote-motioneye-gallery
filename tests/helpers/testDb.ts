import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

/** Creates a throwaway sqlite DB with the current schema and returns a client. */
export function makeTestDb(): { prisma: PrismaClient; url: string } {
  const dir = mkdtempSync(join(tmpdir(), "meg-test-"));
  const url = `file:${join(dir, "test.db")}`;
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "ignore",
  });
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  return { prisma, url };
}
