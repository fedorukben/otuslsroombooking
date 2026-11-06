import { one, q } from "./db.js";
import { hmac, randomToken, safeEqual } from "./crypto.js";
import { HttpError } from "./http.js";

const COOKIE = "rs_admin";
const SESSION_DAYS = 14;

let cachedSecret: string | null = null;

/** Secret for signing cookies and hashing PINs. Created once and stored in the database. */
export async function appSecret(): Promise<string> {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (cachedSecret) return cachedSecret;
  await q("INSERT INTO app_secrets (id, session_secret) VALUES (1, $1) ON CONFLICT (id) DO NOTHING", [randomToken(48)]);
  const row = await one<{ session_secret: string }>("SELECT session_secret FROM app_secrets WHERE id = 1");
  cachedSecret = row!.session_secret;
  return cachedSecret;
}

export interface AdminUser {
  id: number;
  email: string;
  name: string;
  isSuper: boolean;
  /** FALSE for staff accounts (they can sign in and book, but not manage anything). */
  isAdmin: boolean;
}

export async function sessionCookie(adminId: number, req: Request): Promise<string> {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const row = await one<{ session_version: number }>("SELECT session_version FROM admins WHERE id = $1", [adminId]);
  const payload = Buffer.from(JSON.stringify({ a: adminId, e: exp, v: row?.session_version ?? 0 })).toString("base64url");
  const sig = hmac(await appSecret(), payload);
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${payload}.${sig}; Path=/api; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/api; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readCookie(req: Request): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

/** Signed-in admin, or null (staff accounts are not admins). */
export async function currentAdmin(req: Request): Promise<AdminUser | null> {
  const a = await currentAccount(req);
  return a?.isAdmin ? a : null;
}

/** Any signed-in account: staff or admin. */
export async function currentAccount(req: Request): Promise<AdminUser | null> {
  const raw = readCookie(req);
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  if (!safeEqual(sig, hmac(await appSecret(), payload))) return null;
  let data: { a: number; e: number; v?: number };
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString());
  } catch {
    return null;
  }
  if (!data.e || data.e < Date.now()) return null;
  const admin = await one<AdminUser & { session_version: number }>(
    'SELECT id, email, name, is_super AS "isSuper", is_admin AS "isAdmin", session_version FROM admins WHERE id = $1',
    [data.a],
  );
  // A password change or reset bumps session_version, which signs out every older session.
  if (!admin || admin.session_version !== (data.v ?? 0)) return null;
  const { session_version: _v, ...rest } = admin;
  return rest;
}

export async function requireAccount(req: Request): Promise<AdminUser> {
  const a = await currentAccount(req);
  if (!a) throw new HttpError(401, "Please sign in.", { signedOut: true });
  return a;
}

export async function requireAdmin(req: Request): Promise<AdminUser> {
  const a = await requireAccount(req);
  if (!a.isAdmin) throw new HttpError(403, "Your account doesn't have admin access.");
  return a;
}

/** Team PINs are short, so they are HMAC'd with the app secret; rate limiting does the real protecting. */
export async function hashPin(pin: string): Promise<string> {
  return hmac(await appSecret(), `pin:${pin}`);
}

export async function requireSuper(req: Request): Promise<AdminUser> {
  const admin = await requireAdmin(req);
  if (!admin.isSuper) throw new HttpError(403, "Only the super admin can do that.");
  return admin;
}

export async function canManageTeam(admin: AdminUser, teamId: number): Promise<boolean> {
  if (admin.isSuper) return true;
  const row = await one("SELECT 1 FROM team_admins WHERE admin_id = $1 AND team_id = $2", [admin.id, teamId]);
  return !!row;
}

/** Signed-in admin who manages this team (the super admin manages every team). */
export async function requireTeamAdmin(req: Request, teamId: number): Promise<AdminUser> {
  const admin = await requireAdmin(req);
  if (!(await canManageTeam(admin, teamId))) throw new HttpError(403, "You don't manage this team.");
  return admin;
}
