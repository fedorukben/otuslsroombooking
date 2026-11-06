import { q } from "./db.js";
import { HttpError } from "./http.js";

/**
 * Fixed-window counter stored in Postgres (functions are stateless, so memory won't do).
 * Throws 429 when the limit is exceeded.
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number, message?: string) {
  const windowStart = new Date(Math.floor(Date.now() / (windowSeconds * 1000)) * windowSeconds * 1000);
  const rows = await q<{ count: number }>(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count`,
    [key, windowStart],
  );
  if (Math.random() < 0.02) {
    await q("DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '1 day'");
  }
  if (rows[0].count > limit) {
    throw new HttpError(429, message ?? "Too many requests. Please wait a few minutes and try again.");
  }
}
