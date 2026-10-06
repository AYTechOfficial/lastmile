import { handlers } from "@/lib/auth";

/* Auth.js's HTTP surface: /api/auth/session, /csrf, /callback/*, /signin/*,
   /signout. Without this route none of them exist, which is exactly what it
   looks like when sign-in silently 404s. */
export const { GET, POST } = handlers;
