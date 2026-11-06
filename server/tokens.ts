import { createHash } from "node:crypto";
import { one, q, type Queryable, db } from "./db.js";
import { randomToken } from "./crypto.js";
import { HttpError } from "./http.js";

export type TokenKind = "invite" | "reset" | "transfer" | "staff_invite";

export interface TokenRow {
  id: number;
  kind: TokenKind;
  admin_id: number | null;
  email: string;
  name: string;
  team_ids: number[];
  created_by: number | null;
  person_id: number | null;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

/** Creates a single-use link token. Only its hash is stored; the raw token is returned once. */
export async function createToken(
  kind: TokenKind,
  fields: { adminId?: number | null; email?: string; name?: string; teamIds?: number[]; createdBy: number; personId?: number },
  hours: number,
  client: Queryable = db(),
): Promise<{ token: string; row: TokenRow }> {
  const token = randomToken(40);
  const row = await one<TokenRow>(
    `INSERT INTO admin_tokens (kind, token_hash, admin_id, email, name, team_ids, created_by, expires_at, person_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + make_interval(hours => $8), $9) RETURNING *`,
    [kind, sha(token), fields.adminId ?? null, fields.email ?? "", fields.name ?? "", fields.teamIds ?? [], fields.createdBy, hours, fields.personId ?? null],
    client,
  );
  return { token, row: row! };
}

/** Finds an unused, unexpired token of this kind or throws a friendly 404/410. */
export async function openToken(kind: TokenKind, raw: string, client: Queryable = db(), lock = false): Promise<TokenRow> {
  const row = await one<TokenRow>(
    `SELECT * FROM admin_tokens WHERE kind = $1 AND token_hash = $2 ${lock ? "FOR UPDATE" : ""}`,
    [kind, sha(raw)],
    client,
  );
  const what = kind === "invite" || kind === "staff_invite" ? "invite link" : kind === "reset" ? "password reset link" : "handover";
  if (!row) throw new HttpError(404, `This ${what} isn't valid. Ask ${kind === "staff_invite" ? "a team admin" : "the super admin"} for a new one.`);
  if (row.used_at) throw new HttpError(410, `This ${what} has already been used.`);
  if (new Date(row.expires_at).getTime() < Date.now()) throw new HttpError(410, `This ${what} has expired. Ask ${kind === "staff_invite" ? "a team admin" : "the super admin"} for a new one.`);
  return row;
}

export async function useToken(id: number, client: Queryable = db()) {
  await client.query("UPDATE admin_tokens SET used_at = NOW() WHERE id = $1", [id]);
}

/** Older open links of the same kind for the same person are cancelled when a new one is made. */
export async function revokeOpen(kind: TokenKind, where: { adminId?: number; email?: string }) {
  if (where.adminId) await q("UPDATE admin_tokens SET used_at = NOW() WHERE kind = $1 AND admin_id = $2 AND used_at IS NULL", [kind, where.adminId]);
  if (where.email) await q("UPDATE admin_tokens SET used_at = NOW() WHERE kind = $1 AND lower(email) = lower($2) AND used_at IS NULL", [kind, where.email]);
}
