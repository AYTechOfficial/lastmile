/* The operator panel's own login.

   A separate door, deliberately. The panel decides where money goes, which
   models build people's products and who may use the platform; tying that to a
   user account means the keys to the platform are kept inside the product they
   administer. So the panel has its own username, password and optional access
   code, stored as hashes in the settings row it already owns, and the session is
   a signed cookie rather than a row in the user session table.

   Three properties worth stating because they are what makes this safe enough:

     · Only bcrypt hashes are stored. The plaintext is used to verify and then
       forgotten; nothing in the panel can read a password back out.
     · The cookie is an HMAC over an expiry, keyed by AUTH_SECRET. Forging it
       requires the server's own secret, and `generation` is inside the signed
       payload — changing the password invalidates every session that came
       before it, without a session table to clean up.
     · A failed login is rate-limited by the caller, and verification is
       constant-time-ish by construction (bcrypt compare), so the panel does not
       become an oracle for guessing.

   There is still the env-configured operator path (`ADMIN_EMAILS`) — a run
   owner whose address is on that list reaches the panel with their normal
   session. That is the recovery route: if the panel's own credentials are lost,
   an operator with access to the environment can set them again. */

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import bcrypt from "bcryptjs";

import { auth, isAdminEmail } from "../auth";
import { getPlatformData, updatePlatformData, type AdminAuthConfig } from "./settings";

export const ADMIN_COOKIE = "lm_admin";
const SESSION_HOURS = 12;

/** What a login must supply. */
export type AdminCredentialsInput = {
  username: string;
  password: string;
  code?: string;
};

export type AdminAccess =
  | { ok: true; as: "panel"; username: string }
  | { ok: false; reason: "unset" | "bad-credentials" | "bad-code" | "throttled" };

function secret(): string {
  return process.env.AUTH_SECRET?.trim() || "lastmile-admin-dev-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Whether the panel has credentials yet, and what username it expects. */
export async function adminAuthState(): Promise<{ configured: boolean; username: string; requiresCode: boolean }> {
  const { admin } = await getPlatformData();
  if (!admin?.passwordHash) {
    return { configured: false, username: admin?.username ?? "admin", requiresCode: false };
  }
  return { configured: true, username: admin.username, requiresCode: Boolean(admin.codeHash) };
}

/** First run: give the panel a door to open.

    A panel that cannot be entered is a panel nobody configures, and the
    alternative — an operator hand-editing a hash into a database row — is how a
    platform ends up administered by SQL. So an unconfigured panel starts with
    the documented default (admin / admin, no access code) and says so loudly
    until it is changed: the credentials page flags it, and every operator page
    carries the warning. */
export async function seedAdminDefaults(): Promise<boolean> {
  const current = await getPlatformData();
  if (current.admin?.passwordHash) return false;

  const passwordHash = await bcrypt.hash("admin", 10);
  await updatePlatformData((data) => ({
    ...data,
    admin: {
      username: "admin",
      passwordHash,
      codeHash: null,
      generation: 0,
      updatedAt: new Date().toISOString(),
    },
  }));
  return true;
}

/** True while the panel still has the default password — shown as a warning
    banner everywhere until an operator replaces it. */
export async function adminUsesDefaultPassword(): Promise<boolean> {
  const { admin } = await getPlatformData();
  if (!admin?.passwordHash) return true;
  if (admin.username !== "admin") return false;
  return bcrypt.compare("admin", admin.passwordHash);
}

/** Check a login. The order of the checks is the only thing that matters here:
    username and password first, then the code — never the other way round, so a
    wrong code cannot be used to probe whether a username exists. */
export async function verifyAdminCredentials(input: AdminCredentialsInput): Promise<AdminAccess> {
  const { admin } = await getPlatformData();
  if (!admin?.passwordHash) return { ok: false, reason: "unset" };

  const username = input.username.trim();
  const usernameOk = username.toLowerCase() === admin.username.toLowerCase();
  const passwordOk = await bcrypt.compare(input.password, admin.passwordHash);
  if (!usernameOk || !passwordOk) return { ok: false, reason: "bad-credentials" };

  if (admin.codeHash) {
    const code = (input.code ?? "").trim();
    if (!code || !(await bcrypt.compare(code, admin.codeHash))) {
      return { ok: false, reason: "bad-code" };
    }
  }

  return { ok: true, as: "panel", username: admin.username };
}

/** Open a session: an expiry and the credential generation, signed. */
export async function createAdminSession(username: string): Promise<void> {
  const { admin } = await getPlatformData();
  const payload = JSON.stringify({
    u: username,
    g: admin?.generation ?? 0,
    exp: Date.now() + SESSION_HOURS * 60 * 60 * 1000,
  });
  const encoded = Buffer.from(payload).toString("base64url");
  const store = await cookies();
  store.set(ADMIN_COOKIE, `${encoded}.${sign(encoded)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_HOURS * 60 * 60,
  });
}

export async function clearAdminSession(): Promise<void> {
  const store = await cookies();
  store.delete(ADMIN_COOKIE);
}

/** Is there a valid panel session on this request? Returns the username, or
    null — including when the cookie is well-formed but was signed under a
    credential generation that has since been replaced. */
export async function adminSession(): Promise<string | null> {
  const store = await cookies();
  const raw = store.get(ADMIN_COOKIE)?.value;
  if (!raw) return null;

  const [encoded, signature] = raw.split(".");
  if (!encoded || !signature) return null;
  if (!safeEqual(signature, sign(encoded))) return null;

  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      u?: string;
      g?: number;
      exp?: number;
    };
    if (!parsed.u || typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    const { admin } = await getPlatformData();
    if ((admin?.generation ?? 0) !== (parsed.g ?? 0)) return null;
    return parsed.u;
  } catch {
    return null;
  }
}

export type PanelAccess =
  | { ok: true; as: "panel" | "operator"; label: string }
  | { ok: false };

/** Who may see the panel: a panel session, or a signed-in account whose address
    is on ADMIN_EMAILS. The second path is the recovery route — an operator with
    access to the environment can always get back in — and it is the only reason
    the env list still exists now that the panel has its own credentials. */
export async function panelAccess(): Promise<PanelAccess> {
  const username = await adminSession();
  if (username) return { ok: true, as: "panel", label: username };

  const session = await auth();
  const email = session?.user?.email ?? null;
  if (session?.user?.id && isAdminEmail(email)) {
    return { ok: true, as: "operator", label: email ?? "operator" };
  }
  return { ok: false };
}

/** Store new credentials. Only the fields that were actually submitted change:
    leaving the code blank on a save means "no code", which is why clearing it is
    its own checkbox in the form rather than an empty box. */
export async function saveAdminCredentials(input: {
  username: string;
  password?: string | null;
  code?: string | null;
  clearCode?: boolean;
}): Promise<{ ok: boolean; error?: string; notice?: string }> {
  const username = input.username.trim();
  if (username.length < 3) return { ok: false, error: "The username needs at least 3 characters." };

  const password = input.password?.trim() ?? "";
  if (password && password.length < 5) {
    return { ok: false, error: "The password needs at least 5 characters." };
  }

  const current = await getPlatformData();
  const existing = current.admin ?? null;
  if (!password && !existing?.passwordHash) {
    return { ok: false, error: "Set a password — the panel cannot be opened without one." };
  }

  const code = input.code?.trim() ?? "";
  const passwordHash = password ? await bcrypt.hash(password, 10) : existing!.passwordHash;
  const codeHash = input.clearCode ? null : code ? await bcrypt.hash(code, 10) : (existing?.codeHash ?? null);

  const next: AdminAuthConfig = {
    username,
    passwordHash,
    codeHash,
    /* Signing a new generation is what logs every other device out; doing it on
       a password or code change but not on a rename keeps that from being
       annoying for no reason. */
    generation:
      password || code || input.clearCode ? (existing?.generation ?? 0) + 1 : (existing?.generation ?? 0),
    updatedAt: new Date().toISOString(),
  };

  await updatePlatformData((data) => ({ ...data, admin: next }));

  const parts: string[] = [`username “${username}” saved`];
  if (password) parts.push("password changed");
  if (input.clearCode) parts.push("access code removed");
  else if (code) parts.push("access code set");
  return { ok: true, notice: `${parts.join(", ")}.` };
}
