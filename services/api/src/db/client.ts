/**
 * PrismaClient singleton. Kept in one module so the generated client is
 * imported in exactly one place; the rest of the codebase depends on the port
 * interfaces in `src/ports.ts` and the adapters in `prisma-repos.ts`.
 *
 * NOTE: `@prisma/client` must be generated (`npm run prisma:generate`) before
 * type-checking or running this file.
 */

import { PrismaClient } from '@prisma/client';

let singleton: PrismaClient | undefined;

export function getPrisma(databaseUrl?: string): PrismaClient {
  if (!singleton) {
    singleton = databaseUrl
      ? new PrismaClient({ datasources: { db: { url: databaseUrl } } })
      : new PrismaClient();
  }
  return singleton;
}

export type { PrismaClient };
