/* Free models wrap JSON in prose and code fences no matter how politely you
   ask. These helpers dig the object out and, when the model gets a shape
   wrong, coerce it instead of throwing the whole run away. */

/** Pull the first balanced JSON object/array out of arbitrary model output. */
export function extractJson<T = unknown>(text: string): T | null {
  // drop code fences
  const unfenced = text.replace(/```(?:json|JSON)?\s*([\s\S]*?)```/g, "$1");

  const candidates: string[] = [];
  const start = unfenced.search(/[[{]/);
  if (start === -1) return null;

  const open = unfenced[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < unfenced.length; i++) {
    const ch = unfenced[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        candidates.push(unfenced.slice(start, i + 1));
        break;
      }
    }
  }

  // also try the greedy slice — catches truncated trailing braces
  candidates.push(unfenced.slice(start));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // common free-model damage: trailing commas, smart quotes
      try {
        return JSON.parse(
          candidate
            .replace(/,\s*([}\]])/g, "$1")
            .replace(/[\u201c\u201d]/g, '"')
            .replace(/[\u2018\u2019]/g, "'"),
        ) as T;
      } catch {
        /* try the next candidate */
      }
    }
  }
  return null;
}

/** Salvage complete {path, content} file objects out of a truncated or otherwise
    unparseable model response. A pass that already wrote three whole files
    before the output budget ran out should not be thrown away wholesale. */
export function salvageFiles(text: string): { path: string; content: string }[] {
  const unfenced = text.replace(/```(?:json|JSON)?\s*([\s\S]*?)```/g, "$1");
  const start = unfenced.search(/[[{]/);
  if (start === -1) return [];

  const out: { path: string; content: string }[] = [];
  let i = start;
  let inString = false;
  let escaped = false;
  while (i < unfenced.length) {
    const ch = unfenced[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      i++;
      continue;
    }
    if (ch === "{") {
      // scan a balanced object (string-aware) and keep it when it parses as a file
      let depth = 0;
      let sIn = false;
      let sEsc = false;
      let end = -1;
      for (let j = i; j < unfenced.length; j++) {
        const c = unfenced[j];
        if (sIn) {
          if (sEsc) sEsc = false;
          else if (c === "\\") sEsc = true;
          else if (c === '"') sIn = false;
          continue;
        }
        if (c === '"') sIn = true;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            end = j;
            break;
          }
        }
      }
      if (end !== -1) {
        try {
          const obj = JSON.parse(unfenced.slice(i, end + 1)) as { path?: unknown; content?: unknown };
          const p = typeof obj.path === "string" ? obj.path.trim().replace(/^\/+/, "") : "";
          const content = typeof obj.content === "string" ? obj.content : "";
          if (p && !p.includes("..") && content.length > 20) out.push({ path: p, content });
        } catch {
          /* not a parseable object — keep scanning */
        }
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return out;
}

export function asString(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return fallback;
}

export function asStringArray(v: unknown, max = 12): string[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => asString(typeof x === "object" && x ? (x as Record<string, unknown>).name ?? (x as Record<string, unknown>).title : x))
      .filter(Boolean)
      .slice(0, max);
  }
  if (typeof v === "string") {
    return v
      .split(/\n|;|·|\|/)
      .map((s) => s.replace(/^[-*\d.\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, max);
  }
  return [];
}

export function asObjectArray(v: unknown, max = 12): Record<string, unknown>[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object").slice(0, max);
}
