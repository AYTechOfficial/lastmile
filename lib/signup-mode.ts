/* Landing CTA switch — agreed plan: the admin panel (later milestone) will
   control this same setting; for now it's a one-line config flip. */

export type SignupMode = "waitlist" | "open";

export function signupMode(): SignupMode {
  return process.env.NEXT_PUBLIC_SIGNUP_MODE === "open" ? "open" : "waitlist";
}

export function signupOpen(): boolean {
  return signupMode() === "open";
}
