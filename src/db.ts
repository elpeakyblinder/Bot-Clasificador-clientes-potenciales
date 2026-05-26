import { neon } from '@neondatabase/serverless';
import { env } from 'cloudflare:workers';

export function getDb() {
  const cfEnv = env as Record<string, string> | undefined;
  const g = globalThis as Record<string, unknown>;
  const processObj = g.process as Record<string, Record<string, string>> | undefined;

  const databaseUrl = cfEnv?.DATABASE_URL ||
    import.meta.env?.DATABASE_URL ||
    processObj?.env?.DATABASE_URL ||
    "";

  if (!databaseUrl) {
    throw new Error("DATABASE_URL no encontrada.");
  }

  return neon(databaseUrl);
}
