import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

/* Build workspace — where the Coding Agent's codebase lives and what the Deploy
   Agent ships. One directory per run, outside src so Next never compiles it:

     .builds/<runId>/
       app/         the generated product's files
       artifacts/   test screenshots, traces

   Paths in this module are always relative to the workspace root and validated
   against traversal before any read or write. */

const ROOT = process.env.VERCEL
  ? join(tmpdir(), "lastmile-builds")
  : join(process.cwd(), ".builds");

/** mkdir that never throws. Serverless deployments mount the project
 *  directory read-only, so creating .builds/ there raises EROFS; that used to
 *  propagate out of listFiles() and turn the code viewer into a 500. Callers
 *  treat an uncreatable workspace as "empty" and fall back to GitHub. */
function ensureDir(dir: string): string {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* read-only fs or missing parent - reported downstream as no workspace */
  }
  return dir;
}

export function workspaceDir(runId: string): string {
  return ensureDir(join(ROOT, sanitize(runId), "app"));
}

export function artifactsDir(runId: string): string {
  return ensureDir(join(ROOT, sanitize(runId), "artifacts"));
}

export function zipPath(runId: string): string {
  return join(ensureDir(join(ROOT, sanitize(runId))), "codebase.zip");
}

function sanitize(id: string): string {
  if (!/^[0-9a-f-]{8,40}$/i.test(id)) throw new Error("invalid run id");
  return id;
}

/** Refuse anything that escapes the workspace (../, drive letters, NUL). */
function safeRel(path: string): string {
  const rel = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (rel.includes("..") || /^[a-z]:/i.test(rel) || rel.includes("\0")) {
    throw new Error("unsafe path in build workspace: " + path);
  }
  return rel;
}

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", ".turbo", ".vercel", "coverage",
]);

export type WorkspaceFile = { path: string; content: string };

/** Write (or overwrite) a batch of files. Returns the normalized paths. */
export function writeFiles(runId: string, files: WorkspaceFile[]): string[] {
  const base = workspaceDir(runId);
  const written: string[] = [];
  for (const f of files) {
    const rel = safeRel(f.path);
    const abs = join(base, rel);
    ensureDir(abs.slice(0, abs.lastIndexOf(sep)));
    writeFileSync(abs, f.content, "utf8");
    written.push(rel);
  }
  return written;
}

/** Recursive listing, ignoring build noise. Directories end with `/`. */
export function listFiles(runId: string, prefix = ""): string[] {
  const base = join(workspaceDir(runId), safeRel(prefix));
  if (!existsSync(base)) return [];
  const out: string[] = [];

  function walk(dir: string, rel: string) {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const childRel = rel ? rel + "/" + entry : entry;
      if (statSync(abs).isDirectory()) {
        if (IGNORED_DIRS.has(entry) || entry.startsWith(".")) continue;
        out.push(childRel + "/");
        walk(abs, childRel);
      } else {
        out.push(childRel);
      }
    }
  }
  walk(base, safeRel(prefix).replace(/\/$/, "") === "" ? "" : safeRel(prefix).replace(/\/$/, ""));
  return out.sort();
}

export function readWorkspaceFile(runId: string, path: string): string | null {
  try {
    const abs = join(workspaceDir(runId), safeRel(path));
    if (!existsSync(abs) || statSync(abs).isDirectory()) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

export function fileCount(runId: string): number {
  return listFiles(runId).filter((p) => !p.endsWith("/")).length;
}

/** Release a finished run's workspace: delete the whole .builds/<runId>/ tree
 *  (code, artifacts, zip). The repo on GitHub is the source of truth after a
 *  ship; a later iteration restores from it. Idempotent — missing is fine. */
export function deleteWorkspace(runId: string): void {
  rmSync(join(ROOT, sanitize(runId)), { recursive: true, force: true });
}

/* ————————————————————————— zip (stored, no deps) ————————————————————————— */

/* A minimal but correct ZIP writer: no compression (STORED), CRC-32 checked.
   Source trees are small (a few hundred KB of text), so the zip size cost is
   irrelevant next to shipping zero dependencies. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export function zipFiles(files: { path: string; content: Buffer }[], dest: string): void {
  const { time, date } = dosDateTime(new Date());
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = Buffer.from(f.path.replace(/\\/g, "/"), "utf8");
    const data = f.content;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra, comment, disk, internal attrs all zero
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = centrals.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  writeFileSync(dest, Buffer.concat([...locals, ...centrals, end]));
}

/** Zip the workspace (minus ignored dirs) for download. Returns the path. */
export function zipWorkspace(runId: string): string {
  const base = workspaceDir(runId);
  const files: { path: string; content: Buffer }[] = [];

  function walk(dir: string, rel: string) {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const childRel = rel ? rel + "/" + entry : entry;
      if (statSync(abs).isDirectory()) {
        if (IGNORED_DIRS.has(entry) || entry.startsWith(".")) continue;
        walk(abs, childRel);
      } else {
        files.push({ path: childRel, content: readFileSync(abs) });
      }
    }
  }
  walk(base, "");
  const dest = zipPath(runId);
  zipFiles(files, dest);
  return dest;
}

/** Shown in the UI — relative to the project root. */
export function workspaceRelativePath(runId: string): string {
  return relative(process.cwd(), workspaceDir(runId));
}
