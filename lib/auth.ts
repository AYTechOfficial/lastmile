import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { users } from "./schema";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db),
  // credentials providers require JWT sessions; the adapter still persists
  // users and linked OAuth accounts
  session: { strategy: "jwt" },
  providers: [
    // repo scope lets a signed-in user's own token create product repos and
    // push commits — githubTokenForUser() uses it in the pipeline
    GitHub({
      authorization: { params: { scope: "read:user user:email repo" } },
    }),
    Credentials({
      name: "Email & password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email =
          typeof credentials?.email === "string"
            ? credentials.email.trim().toLowerCase()
            : null;
        const password = typeof credentials?.password === "string" ? credentials.password : null;
        if (!email || !password || password.length < 8) return null;

        const [user] = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1);
        if (!user?.passwordHash) return null;

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    // JWT strategy drops the adapter's user id by default — carry it so
    // session.user.id is available to every server component and action
    jwt({ token, user }) {
      if (user?.id) token.id = user.id;
      return token;
    },
    session({ session, token }) {
      if (session.user && token.id) (session.user as { id: string }).id = token.id as string;
      return session;
    },
  },
  pages: { signIn: "/login" },
});
