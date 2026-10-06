import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/* Secret storage for third-party tokens — a user's GitHub PAT, their Vercel
   token, their model keys.

   AES-256-GCM with a fresh 96-bit IV per value, and the auth tag stored
   alongside. The key is derived from AUTH_SECRET, so rotating that secret
   invalidates stored tokens (they fail to decrypt rather than silently
   returning garbage) — which is the correct failure mode.

   Nothing here ever writes a plaintext token to the database, and the
   `maskSecret` helper is what the UI shows back instead of the value. */

const PREFIX = "v1";

function key(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is required to encrypt stored credentials.");
  }
  /* Domain-separated from AUTH_SECRET's other uses, so this key is not the same
     bytes as anything else derived from the same secret. */
  return createHash("sha256").update(secret + ":lastmile:secret-vault").digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), ciphertext.toString("base64"), tag.toString("base64")].join(".");
}

/** Returns null when the value cannot be decrypted — a rotated secret, a
    corrupted row, or a value that was never ciphertext. Callers treat null as
    "not connected" rather than throwing into a page render. */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;

  try {
    const iv = Buffer.from(parts[1], "base64");
    const ciphertext = Buffer.from(parts[2], "base64");
    const tag = Buffer.from(parts[3], "base64");
    const decipher = createDecipheriv("aes-256-gcm", key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** What the UI displays in place of a stored secret. */
export function maskSecret(plaintext: string | null): string {
  if (!plaintext) return "";
  const tail = plaintext.slice(-4);
  return "••••••••" + tail;
}
