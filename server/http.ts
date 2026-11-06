export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const bad = (message: string, extra?: Record<string, unknown>) => new HttpError(400, message, extra);
export const notFound = (message = "Not found") => new HttpError(404, message);

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

const MAX_BODY = 1_000_000; // 1 MB (team logos are sent as data URLs)

export async function body<T = any>(req: Request): Promise<T> {
  const type = req.headers.get("content-type") ?? "";
  // Requiring JSON also blocks cross-site form posts (CSRF): browsers can't send
  // application/json cross-origin without a CORS preflight, which we never approve.
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Expected a JSON request body.");
  }
  const text = await req.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "Request is too large.");
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw bad("Request body is not valid JSON.");
  }
}

export interface RouteContext {
  req: Request;
  params: Record<string, string>;
  url: URL;
  ip: string;
}

export type Handler = (ctx: RouteContext) => Promise<Response>;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler) {
    const keys: string[] = [];
    const pattern = path.replace(/:([a-zA-Z]+)/g, (_, k) => {
      keys.push(k);
      return "([^/]+)";
    });
    this.routes.push({ method, regex: new RegExp(`^${pattern}/?$`), keys, handler });
    return this;
  }
  get(p: string, h: Handler) { return this.add("GET", p, h); }
  post(p: string, h: Handler) { return this.add("POST", p, h); }
  patch(p: string, h: Handler) { return this.add("PATCH", p, h); }
  delete(p: string, h: Handler) { return this.add("DELETE", p, h); }

  async handle(req: Request, ip: string): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "") || "/";
    let methodMismatch = false;
    for (const r of this.routes) {
      const m = r.regex.exec(path);
      if (!m) continue;
      if (r.method !== req.method) {
        methodMismatch = true;
        continue;
      }
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      try {
        return await r.handler({ req, params, url, ip });
      } catch (err) {
        return errorResponse(err);
      }
    }
    return json({ error: methodMismatch ? "Method not allowed" : "Not found" }, methodMismatch ? 405 : 404);
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.message, ...err.extra }, err.status);
  }
  const pgCode = (err as { code?: string })?.code;
  if (pgCode === "23P01") {
    return json({ error: "Someone just booked an overlapping time in this room. Refresh the calendar and try again." }, 409);
  }
  if (pgCode === "23505") {
    return json({ error: "That name is already in use." }, 409);
  }
  if (pgCode === "23503") {
    return json({ error: "This item is still in use, so it can't be deleted. Deactivate it instead." }, 409);
  }
  console.error(err);
  return json({ error: "Something went wrong on the server." }, 500);
}

// ---------- small input helpers ----------

export function str(v: unknown, field: string, { max = 200, required = false } = {}): string {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw bad(`${field} must be text.`);
  const s = v.trim();
  if (required && !s) throw bad(`${field} is required.`);
  if (s.length > max) throw bad(`${field} must be ${max} characters or fewer.`);
  return s;
}

export function int(v: unknown, field: string, { min = -Infinity, max = Infinity, nullable = false } = {}): number | null {
  if (v === null || v === undefined || v === "") {
    if (nullable) return null;
    throw bad(`${field} is required.`);
  }
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n)) throw bad(`${field} must be a whole number.`);
  if (n < min || n > max) throw bad(`${field} must be between ${min} and ${max}.`);
  return n;
}

export function bool(v: unknown): boolean {
  return v === true || v === "true";
}

export function color(v: unknown, field: string, fallback = "#0b5cad"): string {
  if (v === undefined || v === null || v === "") return fallback;
  if (typeof v !== "string" || !/^#[0-9a-fA-F]{6}$/.test(v)) throw bad(`${field} must be a colour like #0b5cad.`);
  return v.toLowerCase();
}

export function isoDate(v: unknown, field: string): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v + "T00:00:00Z"))) {
    throw bad(`${field} must be a date (YYYY-MM-DD).`);
  }
  return v;
}
