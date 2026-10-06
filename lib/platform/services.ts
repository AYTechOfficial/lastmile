import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { userCredentials } from "../schema";
import { decryptSecret, encryptSecret, maskSecret } from "../crypto";
import { getPlatformData } from "./settings";

/* Third-party credentials, and who is allowed to see them.

   Every service follows one rule, implemented once here:

       1. the credential the USER supplied for that service, if any
       2. otherwise the PLATFORM's default

   The platform defaults are operator infrastructure — they live in server-side
   environment variables and, optionally, in the encrypted admin settings row.
   A normal user never receives them, not even masked: they are told the service
   is included, not what it is. Only an operator sees the masking and can edit it.

   That asymmetry is the whole design. It is what lets the product work out of the
   box for someone who signs up and types a sentence, without handing them the
   operator's keys. */

export type ServiceId = "github" | "vercel" | "render" | "search" | "browser";

export type ServiceDef = {
  id: ServiceId;
  label: string;
  /** the environment variable holding the platform default */
  envVar: string;
  /** what connecting your own account gets you */
  userBenefit: string;
  /** where a user obtains their own key */
  keysUrl: string;
  placeholder: string;
};

export const SERVICES: ServiceDef[] = [
  {
    id: "github",
    label: "GitHub",
    envVar: "GITHUB_TOKEN",
    userBenefit: "Your generated projects are created and committed under your own account.",
    keysUrl: "https://github.com/settings/tokens",
    placeholder: "ghp_… or github_pat_…",
  },
  {
    id: "vercel",
    label: "Vercel",
    envVar: "VERCEL_TOKEN",
    userBenefit: "Your projects deploy to your own Vercel account, so the URL is yours.",
    keysUrl: "https://vercel.com/account/settings/tokens",
    placeholder: "your Vercel token",
  },
  {
    id: "render",
    label: "Render",
    envVar: "RENDER_API_KEY",
    userBenefit: "Alternative deploy target, when you would rather not use Vercel.",
    keysUrl: "https://dashboard.render.com/u/settings#api-keys",
    placeholder: "rnd_…",
  },
  {
    id: "search",
    label: "Web search",
    envVar: "TAVILY_API_KEY",
    userBenefit: "Your own research quota, so long runs never queue behind the platform's.",
    keysUrl: "https://app.tavily.com/home",
    placeholder: "tvly-…",
  },
  {
    id: "browser",
    label: "Live QA browser",
    envVar: "BROWSER_USE_API_KEY",
    userBenefit: "Your own cloud browser sessions for the live test stage.",
    keysUrl: "https://cloud.browser-use.com",
    placeholder: "bu_…",
  },
];

export function serviceDef(id: ServiceId): ServiceDef {
  const found = SERVICES.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown service: ${id}`);
  return found;
}

/** The platform's own default for a service, or null when it is not configured.
    Admin-stored values override the environment, which is what makes the admin
    panel able to rotate a key without a redeploy. */
async function platformValue(id: ServiceId): Promise<string | null> {
  const def = serviceDef(id);

  try {
    const { infra } = await getPlatformData();
    const stored =
      id === "github" ? infra.githubTokenEncrypted
      : id === "vercel" ? infra.vercelTokenEncrypted
      : null;
    const fromSettings = decryptSecret(stored);
    if (fromSettings) return fromSettings;
  } catch {
    /* Settings are best-effort here; the environment still answers. */
  }

  return process.env[def.envVar]?.trim() || null;
}

export type ResolvedCredential = {
  value: string | null;
  source: "user" | "platform" | null;
};

/** The credential to actually use, plus where it came from. This is the single
    entry point every integration calls — nothing else should read a token out of
    the environment directly. */
export async function resolveServiceCredential(
  userId: string | null,
  id: ServiceId,
): Promise<ResolvedCredential> {
  if (userId) {
    const [row] = await db
      .select({ value: userCredentials.valueEncrypted })
      .from(userCredentials)
      .where(and(eq(userCredentials.userId, userId), eq(userCredentials.service, id)))
      .limit(1);

    const own = decryptSecret(row?.value);
    if (own) return { value: own, source: "user" };
  }

  const platform = await platformValue(id);
  return { value: platform, source: platform ? "platform" : null };
}

/* ————————————————————————— storing a user's own key ————————————————————————— */

export async function setUserCredential(
  userId: string,
  id: ServiceId,
  value: string,
  label: string | null,
): Promise<void> {
  const now = new Date();
  await db
    .insert(userCredentials)
    .values({
      userId,
      service: id,
      valueEncrypted: encryptSecret(value.trim()),
      label: label?.slice(0, 120) ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userCredentials.userId, userCredentials.service],
      set: { valueEncrypted: encryptSecret(value.trim()), label: label?.slice(0, 120) ?? null, updatedAt: now },
    });
}

export async function clearUserCredential(userId: string, id: ServiceId): Promise<void> {
  await db
    .delete(userCredentials)
    .where(and(eq(userCredentials.userId, userId), eq(userCredentials.service, id)));
}

/* ————————————————————————— what each audience may see ————————————————————————— */

/** What the Settings page shows a normal user. A platform-provided service
    reports only that it is included — the key itself is never described. */
export type UserServiceView = {
  id: ServiceId;
  label: string;
  userBenefit: string;
  keysUrl: string;
  placeholder: string;
  /** "user" when they supplied their own, "platform" when they are riding on ours */
  source: "user" | "platform" | null;
  /** present only for their own key */
  keyMask: string | null;
  label_: string | null;
};

export async function userServiceViews(userId: string): Promise<UserServiceView[]> {
  const rows = await db
    .select()
    .from(userCredentials)
    .where(eq(userCredentials.userId, userId));

  const mine = new Map(rows.map((r) => [r.service as ServiceId, r]));

  return Promise.all(
    SERVICES.map(async (def) => {
      const own = mine.get(def.id);
      if (own) {
        return {
          id: def.id,
          label: def.label,
          userBenefit: def.userBenefit,
          keysUrl: def.keysUrl,
          placeholder: def.placeholder,
          source: "user" as const,
          keyMask: maskSecret(decryptSecret(own.valueEncrypted)),
          label_: own.label,
        };
      }

      const platform = await platformValue(def.id);
      return {
        id: def.id,
        label: def.label,
        userBenefit: def.userBenefit,
        keysUrl: def.keysUrl,
        placeholder: def.placeholder,
        source: platform ? ("platform" as const) : null,
        /* Deliberately null for a platform credential: the user is told the
           service is available, never what the operator's key looks like. */
        keyMask: null,
        label_: null,
      };
    }),
  );
}

/** What /admin shows an operator — including the platform defaults, masked.
    Callers must check `isAdminEmail` before rendering this. */
export type AdminServiceView = {
  id: ServiceId;
  label: string;
  envVar: string;
  configured: boolean;
  keyMask: string | null;
  /** where the platform default comes from, so the operator knows where to edit it */
  from: "settings" | "env" | null;
};

export async function adminServiceViews(): Promise<AdminServiceView[]> {
  const { infra } = await getPlatformData();

  return SERVICES.map((def) => {
    const stored =
      def.id === "github" ? infra.githubTokenEncrypted
      : def.id === "vercel" ? infra.vercelTokenEncrypted
      : null;
    const decrypted = decryptSecret(stored);
    if (decrypted) {
      return {
        id: def.id,
        label: def.label,
        envVar: def.envVar,
        configured: true,
        keyMask: maskSecret(decrypted),
        from: "settings" as const,
      };
    }

    const env = process.env[def.envVar]?.trim();
    return {
      id: def.id,
      label: def.label,
      envVar: def.envVar,
      configured: Boolean(env),
      keyMask: env ? maskSecret(env) : null,
      from: env ? ("env" as const) : null,
    };
  });
}
