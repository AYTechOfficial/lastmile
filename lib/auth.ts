import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { accounts, sessions, users, verificationTokens } from "./schema";
import { planOf, type PlanId } from "./plans";

/* Auth.js v5.

   JWT sessions rather than database sessions: the credentials provider requires
   them, and they also mean a signed-in request costs no extra round trip — which
   matters on a serverless host where every query is a connection.

   PLAN ON THE SESSION is deliberate. The plan decides which model tier a run may
   route to and how many iterations its quality loop gets. Resolving it from the
   session at the point of use keeps that decision server-side, where a client
   cannot escalate it. */

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
      /* Reading the user's verified email address is what lets a GitHub sign-in
         match an existing password account instead of creating a second one. */
      allowDangerousEmailAccountLinking: true,
    }),
    Credentials({
      name: "Email and password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const email = String(raw?.email ?? "").trim().toLowerCase();
        const password = String(raw?.password ?? "");
        if (!email || !password) return null;

        const [user] = await db
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            image: users.image,
            passwordHash: users.passwordHash,
            plan: users.plan,
            suspendedAt: users.suspendedAt,
          })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        if (!user?.passwordHash) return null;

        /* An operator can block an account, and a block that only hides pages
           is theatre: the password is still checked, but the session is never
           issued. The message says "suspended" rather than "wrong password" so
           a blocked person is not sent hunting for a typo that does not exist. */
        if (user.suspendedAt) {
          throw new Error("This account is suspended. Contact the operator if you think that is wrong.");
        }

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;

        return { id: user.id, email: user.email, name: user.name, image: user.image };
      },
    }),
  ],
  callbacks: {
    /* The credentials path checks the block itself (it has to, to give an
       honest message); this covers the OAuth path, where the adapter would
       otherwise sign a suspended person straight back in. */
    async signIn({ user }) {
      const email = user?.email?.trim().toLowerCase();
      if (!email) return true;
      const [row] = await db
        .select({ suspendedAt: users.suspendedAt })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return !row?.suspendedAt;
    },
    jwt({ token, user, trigger, session }) {
      if (user?.id) token.uid = user.id;
      /* Profile edits (name / email / avatar) update the signed-in session in
         place, so the shell reflects them without a re-login. The update
         payload is the Session shape: { user: { name?, email?, image? } }. */
      if (trigger === "update" && session) {
        const s = session as {
          name?: string | null;
          email?: string | null;
          image?: string | null;
          user?: { name?: string | null; email?: string | null; image?: string | null };
        };
        const u = s.user ?? s;
        if (u.name !== undefined) token.name = u.name;
        if (u.email !== undefined) token.email = u.email;
        if (u.image !== undefined) token.picture = u.image;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user && typeof token.uid === "string") {
        session.user.id = token.uid;
      }
      return session;
    },
  },
});

/** Operators allowed into /admin, from the environment. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

/** The plan a session is entitled to. */
export function sessionPlan(plan: string | null | undefined): PlanId {
  return planOf(plan).id;
}
