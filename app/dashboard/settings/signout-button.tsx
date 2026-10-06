"use client";

import { btn } from "@/components/kit";
import { directSignOut } from "@/lib/client-auth";

export function SignoutButton() {
  return (
    <button type="button" onClick={() => void directSignOut()} className={btn("danger", "md")}>
      Sign out
    </button>
  );
}
