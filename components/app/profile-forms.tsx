"use client";

import { useActionState, useRef, useState } from "react";
import { Camera, Check, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/cn";
import { btn } from "@/components/kit";
import {
  changePasswordAction,
  updateEmailAction,
  updateProfileAction,
  type ProfileResult,
} from "@/app/actions/profile";

/* Account controls that actually work: name + avatar, email (with the
   current password and a notice to the old address), password. Every form
   reports the truth inline — including when email delivery is not configured. */

const inputCls =
  "w-full rounded-[10px] border border-edge bg-well px-3.5 py-2.5 text-[13.5px] text-t1 outline-none transition-colors placeholder:text-t3 focus:border-brand/60";

function Result({ state }: { state: ProfileResult }) {
  if (state.error) {
    return (
      <p role="alert" className="flex items-start gap-2 rounded-[10px] border border-bad/30 bg-bad/10 px-3 py-2 text-[12.5px] text-bad">
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {state.error}
      </p>
    );
  }
  if (state.notice) {
    return (
      <p role="status" className="flex items-start gap-2 rounded-[10px] border border-pass/30 bg-pass/10 px-3 py-2 text-[12.5px] text-pass">
        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {state.notice}
      </p>
    );
  }
  return null;
}

/* ————— name + avatar ————— */

export function ProfileForm({
  name,
  image,
  email,
}: {
  name: string;
  image: string | null;
  email: string;
}) {
  const [state, action, pending] = useActionState(updateProfileAction, { ok: false });
  const [preview, setPreview] = useState<string | null>(null);
  const [fileErr, setFileErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPick = (file: File | undefined) => {
    setFileErr(null);
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setFileErr("PNG, JPEG or WebP only.");
      return;
    }
    if (file.size > 500 * 1024) {
      setFileErr("Image must be under 500 KB.");
      return;
    }
    setPreview(URL.createObjectURL(file));
  };

  const avatarSrc = preview ?? image;
  const initial = (name || email).slice(0, 1).toUpperCase();

  return (
    <form action={action} className="space-y-4 p-4">
      <div className="flex flex-wrap items-center gap-4">
        <span className="relative block h-16 w-16 shrink-0 overflow-hidden rounded-full border border-edge bg-surface2">
          {avatarSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarSrc} alt="Avatar preview" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full w-full items-center justify-center bg-gradient-to-br from-brand/50 to-info/30 text-[20px] font-semibold text-white">
              {initial}
            </span>
          )}
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-t1">Profile picture</p>
          <p className="mt-0.5 text-[11.5px] text-t3">PNG, JPEG or WebP · up to 500 KB</p>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className={btn("outline", "sm")}
            >
              <Camera className="h-3.5 w-3.5" />
              Choose image
            </button>
            {preview ? (
              <button
                type="button"
                onClick={() => {
                  setPreview(null);
                  if (fileRef.current) fileRef.current.value = "";
                }}
                className="text-[11.5px] text-t3 underline decoration-dotted underline-offset-2 hover:text-t2"
              >
                undo
              </button>
            ) : null}
          </div>
          <input
            ref={fileRef}
            type="file"
            name="avatar"
            accept="image/png,image/jpeg,image/webp"
            className="sr-only"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
        </div>
      </div>
      {fileErr ? <p className="text-[12px] text-bad">{fileErr}</p> : null}

      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">Display name</span>
        <input type="text" name="name" defaultValue={name} minLength={2} maxLength={60} required className={inputCls} />
      </label>

      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">Email</span>
        <input type="email" value={email} disabled className={cn(inputCls, "opacity-55")} />
        <span className="mt-1 block text-[11px] text-t3">
          The email is changed below, with your password and a notice to the old address.
        </span>
      </label>

      <div className="flex items-center justify-between gap-3">
        <Result state={state} />
        <button type="submit" disabled={pending} className={btn("brand", "md", "ml-auto")}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Save profile
        </button>
      </div>
    </form>
  );
}

/* ————— email ————— */

export function EmailForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState(updateEmailAction, { ok: false });
  return (
    <form action={action} className="space-y-3.5 p-4">
      <p className="text-[12.5px] leading-relaxed text-t3">
        Changing the email signs you in with the new address from now on. The current one
        (<span className="font-mono text-t2">{email}</span>) receives a notice either way.
      </p>
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">New email</span>
        <input type="email" name="email" required placeholder="you@example.com" className={inputCls} />
      </label>
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">Current password</span>
        <input type="password" name="password" required autoComplete="current-password" className={inputCls} />
      </label>
      <div className="flex items-center justify-between gap-3">
        <Result state={state} />
        <button type="submit" disabled={pending} className={btn("brand", "md", "ml-auto")}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Change email
        </button>
      </div>
    </form>
  );
}

/* ————— password ————— */

export function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const [state, action, pending] = useActionState(changePasswordAction, { ok: false });
  if (!hasPassword) {
    return (
      <p className="p-4 text-[12.5px] leading-relaxed text-t3">
        This account signs in with GitHub, so it has no password of its own. Set one by signing out and
        using &ldquo;reset password&rdquo; on the login screen.
      </p>
    );
  }
  return (
    <form action={action} className="space-y-3.5 p-4">
      <p className="text-[12.5px] leading-relaxed text-t3">
        All devices stay signed in. The account&apos;s email receives a confirmation notice.
      </p>
      <label className="block">
        <span className="eyebrow eyebrow-strong mb-1.5 block">Current password</span>
        <input type="password" name="current" required autoComplete="current-password" className={inputCls} />
      </label>
      <div className="grid gap-3.5 sm:grid-cols-2">
        <label className="block">
          <span className="eyebrow eyebrow-strong mb-1.5 block">New password</span>
          <input type="password" name="next" required minLength={8} autoComplete="new-password" className={inputCls} />
        </label>
        <label className="block">
          <span className="eyebrow eyebrow-strong mb-1.5 block">Repeat new password</span>
          <input type="password" name="confirm" required minLength={8} autoComplete="new-password" className={inputCls} />
        </label>
      </div>
      <div className="flex items-center justify-between gap-3">
        <Result state={state} />
        <button type="submit" disabled={pending} className={btn("brand", "md", "ml-auto")}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          Update password
        </button>
      </div>
    </form>
  );
}
