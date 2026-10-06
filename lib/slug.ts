/* Turning the user's one sentence into the names everything else needs.

   Pure functions, no I/O — the dashboard needs a title the moment a run is
   created, and the runner needs the same slug later when it creates the repo.
   Sharing one implementation is what stops the two from disagreeing. */

const STOP = new Set([
  "a", "an", "the", "for", "with", "of", "to", "and", "in", "on", "my",
  "that", "which", "app", "application", "tool", "platform", "website", "site",
]);

/** Repo-safe, DNS-safe, three words at most. Never empty. */
export function slugify(sentence: string): string {
  const words = sentence
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));

  const slug = words.slice(0, 3).join("-").slice(0, 40).replace(/-+$/, "");
  return slug || "app";
}

/** Sentence case for the run header. */
export function titleFrom(sentence: string): string {
  const clean = sentence.trim().replace(/\.+$/, "");
  if (!clean) return "Untitled run";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Collapse whitespace and trim — applied before validation so a sentence
    padded with newlines is judged on its content. */
export function normalizeSentence(sentence: string): string {
  return sentence.trim().replace(/\s+/g, " ");
}

export const SENTENCE_MIN = 10;
export const SENTENCE_MAX = 200;
