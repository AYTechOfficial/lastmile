import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/* Admin-stored secrets (provider API keys) are encrypted at rest with
   AES-256-GCM. The key is derived from APP_ENCRYPTION_KEY, falling back to
   AUTH_SECRET — both server-only env, so plaintext keys never reach the
   database or the client. Ciphertext format: v1.<iv-b64>.<tag-b64>.<data-b64> */

const VERSION = "v1";

function masterKey(): Buffer {
  const secret =
    process.env.APP_ENCRYPTION_KEY?.trim() || process.env.AUTH_SECRET?.trim() || "";
  if (!secret) {
    throw new Error("No APP_ENCRYPTION_KEY or AUTH_SECRET set — cannot encrypt provider keys");
  }
  return scryptSync(secret, "lastmile.provider-keys.v1", 32);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), enc.toString("base64")].join(".");
}

export function decryptSecret(stored: string): string | null {
  try {
    const [version, ivB64, tagB64, dataB64] = stored.split(".");
    if (version !== VERSION) return null;
    const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null; // wrong master key or tampered ciphertext
  }
}

/** Never render a full key — show enough to identify it, nothing more. */
export function maskKey(plaintext: string): string {
  if (plaintext.length <= 8) return "••••••••";
  return plaintext.slice(0, 3) + "…••••" + plaintext.slice(-4);
}
