import Link from "next/link";

import { AuthShell } from "@/components/auth-shell";
import { LoginForm } from "./login-form";
import { GithubSigninButton } from "./github-signin";
import { signupOpen } from "@/lib/signup-mode";

export const metadata = { title: "Sign in — LastMile" };

export default function LoginPage() {
  const open = signupOpen();

  return (
    <AuthShell
      title={<>Welcome back. Sign in to your workspace.</>}
      footer={
        open ? (
          <>
            New here?{" "}
            <Link href="/signup" className="text-brand transition-colors hover:text-t1">
              Create an account
            </Link>
          </>
        ) : (
          <>
            Signups are invite-only right now —{" "}
            <Link href="/#waitlist" className="text-brand transition-colors hover:text-t1">
              join the waitlist
            </Link>
          </>
        )
      }
    >
      <LoginForm />

      <div className="my-6 flex items-center gap-3">
        <span className="h-px flex-1 bg-edge" />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-t3">or</span>
        <span className="h-px flex-1 bg-edge" />
      </div>

      <GithubSigninButton />
    </AuthShell>
  );
}
