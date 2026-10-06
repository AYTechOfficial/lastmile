/* Is this user connected to a Vercel account?

   Read through the credential layer for the same reason everything else is:
   a user's own token wins, otherwise they ride the operator's. The username is
   stored only for a user's own connection — a platform token belongs to the
   operator, so naming it to the user would be wrong as well as unhelpful. */

import { eq } from "drizzle-orm";
import { db } from "../db";
import { users } from "../schema";
import { resolveServiceCredential } from "./services";

export type VercelStatus = {
  connected: boolean;
  account: string | null;
  source: "user" | "platform" | null;
};

export async function vercelConnectionStatus(userId: string | null): Promise<VercelStatus> {
  const { value, source } = await resolveServiceCredential(userId, "vercel");

  if (!value) return { connected: false, account: null, source: null };

  let account: string | null = null;
  if (source === "user" && userId) {
    const [row] = await db
      .select({ vercelAccount: users.vercelAccount })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    account = row?.vercelAccount ?? null;
  }

  return { connected: true, account, source };
}
