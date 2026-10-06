import Link from "next/link";
import { Hourglass } from "lucide-react";
import { AuthShell } from "@/components/auth-shell";
import { SignupForm } from "./signup-form";
import { GithubSigninButton } from "@/app/login/github-signin";
import { signupOpen } from "@/lib/signup-mode";
import { Badge, btn } from "@/components/kit";

export const metadata = { title: "Create your account — LastMile" };

export default async function SignupPage() {
  if (!signupOpen()) {
    return (
      <AuthShell
        title={<>Signups open in batches.</>}
        footer={
          <>
            Already have an account?{" "}
            <Link href="/login" className="text-brand transition-colors hover:text-t1">
              Sign in
            </Link>
          </>
        }
      >
        <Badge tone="warn" dot>
          invite only · phase 1
        </Badge>
        <p className="mt-4 text-[13.5px] leading-relaxed text-t2">
          We onboard straight from the waitlist, one batch at a time, so every account gets a pipeline
          that is actually verified end to end before it is handed over.
        </p>
        <Link href="/#waitlist" className={btn("primary", "lg", "mt-6 w-full font-semibold")}>
          <Hourglass className="h-4 w-4" />
          Join the waitlist
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={<>One sentence in. Start your account.</>}
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="text-brand transition-colors hover:text-t1">
            Sign in
          </Link>
        </>
      }
    >
      <SignupForm />

      <div className="my-6 flex items-center gap-3">
        <span className="h-px flex-1 bg-edge" />
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-t3">or</span>
        <span className="h-px flex-1 bg-edge" />
      </div>

      <GithubSigninButton />
    </AuthShell>
  );
}
