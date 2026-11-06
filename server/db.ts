import { getDatabase } from "@netlify/database";

export interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

/** Anything that can run a parameterized query: the pool or a transaction client. */
export interface Queryable {
  query<T = any>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

let pool: PoolLike | null = null;

/**
 * One shared pool per function instance (created on first use, reused across invocations).
 * On Netlify the connection string comes from NETLIFY_DB_URL automatically.
 * ROOMS_DB_URL lets the local test harness point at any Postgres.
 */
export function db(): PoolLike {
  if (!pool) {
    const override = process.env.ROOMS_DB_URL;
    const conn = getDatabase(override ? { connectionString: override } : {});
    pool = conn.pool as unknown as PoolLike;
    // Idle connections can be closed by the server (e.g. Neon scaling to zero). Without a listener,
    // the pool's 'error' event would crash the process; the pool already discards the dead client.
    (conn.pool as unknown as { on(ev: string, fn: (e: Error) => void): void }).on("error", (err) => {
      console.warn("Database pool: idle connection closed:", err.message);
    });
  }
  return pool;
}

export async function q<T = any>(text: string, params: unknown[] = [], client: Queryable = db()): Promise<T[]> {
  const res = await client.query<T>(text, params);
  return res.rows;
}

export async function one<T = any>(text: string, params: unknown[] = [], client: Queryable = db()): Promise<T | null> {
  const rows = await q<T>(text, params, client);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}
