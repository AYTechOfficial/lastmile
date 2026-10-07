/* Transactional email — security notifications only, on purpose.

   The two mails this product sends are the ones a user must know about even
   when they are not the one typing: a password change and an email change.
   Everything else stays in the dashboard.

   Delivery rides Resend's HTTP API when RESEND_API_KEY is set. When it is
   not, nothing pretends: the caller gets `sent: false` with a reason and the
   UI says the notice could not be emailed. A silent no-op here would mean a
   user believes their old address was warned when it was not. */

const FROM = process.env.MAIL_FROM?.trim() || "LastMile <onboarding@resend.dev>";

export type MailResult = { sent: boolean; reason?: string };

async function deliver(to: string, subject: string, html: string): Promise<MailResult> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) {
    return { sent: false, reason: "no-mail-provider" };
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, html }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { sent: true };
    const body = (await res.text()).slice(0, 200);
    console.error("mail send rejected", { status: res.status, body });
    return { sent: false, reason: `mail provider answered HTTP ${res.status}` };
  } catch (error) {
    console.error("mail send failed", error);
    return { sent: false, reason: "could not reach the mail provider" };
  }
}

const shell = (title: string, body: string) => `
  <div style="background:#08090d;padding:32px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#eef0f6;">
    <div style="max-width:520px;margin:0 auto;border:1px solid rgba(255,255,255,.1);border-radius:12px;background:#0e1016;padding:28px;">
      <p style="margin:0 0 4px;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:#7c7aff;">LastMile</p>
      <h1 style="margin:0 0 16px;font-size:18px;font-weight:600;">${title}</h1>
      <div style="font-size:13.5px;line-height:1.7;color:rgba(238,240,246,.72);">${body}</div>
      <p style="margin:24px 0 0;font-size:11px;color:rgba(238,240,246,.38);border-top:1px solid rgba(255,255,255,.08);padding-top:16px;">
        If this wasn't you, sign in and change your password immediately.
      </p>
    </div>
  </div>`;

export function passwordChangedEmail(): { subject: string; html: string } {
  return {
    subject: "Your LastMile password was changed",
    html: shell(
      "Password changed",
      "<p>The password for your LastMile account was just changed.</p><p>All existing sign-ins stay active. If this wasn't you, reset your password now.</p>",
    ),
  };
}

export function emailChangedEmail(oldEmail: string, newEmail: string): { subject: string; html: string } {
  return {
    subject: "Your LastMile email was changed",
    html: shell(
      "Email changed",
      `<p>The email on your LastMile account was just changed.</p>
       <p>From: <strong>${oldEmail}</strong><br/>To: <strong>${newEmail}</strong></p>
       <p>Sign in from now on with the new address. If this wasn't you, reply to this email immediately.</p>`,
    ),
  };
}

export { deliver as sendMail };
