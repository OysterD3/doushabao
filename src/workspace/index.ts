/**
 * Workspace registry — src/workspace.
 *
 * Owns: workspace creation from boilerplate + workspace.json meta CRUD,
 * transcript append/tail, KB shared+overlay with provenance/promote/revoke,
 * memory admin ops, unanswered/escalation records.
 *
 * See ARCHITECTURE.md for the module boundary and docs/brainstorming/*.content.json
 * for the product decisions this encodes (overlay-wins KB, provenance kept on
 * promote, deterministic authz lives in the caller, not here).
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { paths, wsPaths } from "../shared/paths.ts";
import type { Boilerplate, Config, ConversationType, KbEntry, ToolResponse, WorkspaceMeta } from "../shared/types.ts";
import { instantiateBoilerplate } from "../pi/index.ts";
import { appendJsonl, slug, writeFileAtomic } from "./fs-util.ts";
import { deleteKbEntry, readKbEntries, readKbEntry, writeKbEntry } from "./kb.ts";

export interface TranscriptEntry {
  ts: number;
  senderId: string;
  senderName?: string;
  text: string;
}

export interface WorkspaceRegistry {
  getOrCreate(cid: string, type: ConversationType): Promise<{ meta: WorkspaceMeta; created: boolean }>;
  get(cid: string): WorkspaceMeta | undefined;
  list(): WorkspaceMeta[];
  patchMeta(cid: string, patch: Partial<WorkspaceMeta>): Promise<WorkspaceMeta>;
  appendTranscript(cid: string, entry: TranscriptEntry): Promise<void>;
  transcriptTail(cid: string, n: number): Promise<string[]>;
  kbSave(entry: Omit<KbEntry, "id" | "injectedAt" | "revoked">): Promise<KbEntry>;
  kbPromote(kbId: string, actor: string): Promise<KbEntry | undefined>;
  kbRevoke(kbId: string, actor: string): Promise<boolean>;
  kbList(cid: string): Promise<KbEntry[]>;
  kbDigest(cid: string): Promise<string>;
  recordUnanswered(cid: string, question: string, senderId: string): Promise<void>;
  recordEscalation(cid: string, question: string, context: string, senderId: string): Promise<void>;
  memoryAdmin(cid: string, op: "list" | "read" | "write" | "delete", name?: string, content?: string): Promise<ToolResponse>;
}

const MEMORY_NAME_RE = /^[A-Za-z0-9_-]+$/;
const KB_DIGEST_CAP = 4000;
/** Runtime companion of the Boilerplate union — a patch arrives as plain JSON. */
const BOILERPLATES: readonly Boilerplate[] = ["general", "qa-cs", "project", "dev-mgmt"];

const kbDirFor = (dir: string) => wsPaths(dir).kb;
const memoryDirFor = (dir: string) => join(dir, "memory");

function scanWorkspaces(): Map<string, WorkspaceMeta> {
  const map = new Map<string, WorkspaceMeta>();
  if (!existsSync(paths.workspaces)) return map;
  for (const name of readdirSync(paths.workspaces)) {
    const dir = join(paths.workspaces, name);
    const metaFile = wsPaths(dir).meta;
    if (!existsSync(metaFile)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaFile, "utf8")) as WorkspaceMeta;
      map.set(meta.conversationId, meta);
    } catch {
      /* skip corrupt workspace.json */
    }
  }
  return map;
}

function writeMeta(meta: WorkspaceMeta): void {
  writeFileAtomic(wsPaths(meta.dir).meta, JSON.stringify(meta, null, 2));
}

function formatHHMM(ts: number, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false });
  return fmt.format(new Date(ts));
}

export function createWorkspaceRegistry(cfg: Config): WorkspaceRegistry {
  const metaMap = scanWorkspaces();
  const creating = new Map<string, Promise<WorkspaceMeta>>();

  // Monotonic clock for KB provenance: Date.now() has ms resolution, so a
  // tight loop of kbSave calls (e.g. a bulk import) can tie, which would
  // make readKbEntries' injectedAt-order (and therefore kbDigest's cap)
  // nondeterministic. Strictly increasing timestamps keep creation order
  // stable without changing the KbEntry shape.
  let lastInjectedAt = 0;
  function nextInjectedAt(): number {
    const now = Date.now();
    lastInjectedAt = now > lastInjectedAt ? now : lastInjectedAt + 1;
    return lastInjectedAt;
  }

  function requireMeta(cid: string): WorkspaceMeta {
    const meta = metaMap.get(cid);
    if (!meta) throw new Error(`workspace registry: unknown conversation id "${cid}"`);
    return meta;
  }

  async function getOrCreate(cid: string, type: ConversationType): Promise<{ meta: WorkspaceMeta; created: boolean }> {
    const existing = metaMap.get(cid);
    if (existing) return { meta: existing, created: false };

    let inflight = creating.get(cid);
    if (!inflight) {
      inflight = (async () => {
        const dir = join(paths.workspaces, slug(cid));
        mkdirSync(dir, { recursive: true });
        await instantiateBoilerplate("general", dir);
        for (const sub of ["jobs", "kb", "media", "memory"]) mkdirSync(join(dir, sub), { recursive: true });
        const meta: WorkspaceMeta = {
          conversationId: cid,
          conversationType: type,
          dir,
          boilerplate: "general",
          editors: [],
          multimodal: false,
          digestsEnabled: false,
          createdAt: Date.now(),
          greeted: false,
        };
        writeMeta(meta);
        metaMap.set(cid, meta);
        return meta;
      })();
      creating.set(cid, inflight);
    }
    try {
      const meta = await inflight;
      return { meta, created: true };
    } finally {
      creating.delete(cid);
    }
  }

  function get(cid: string): WorkspaceMeta | undefined {
    return metaMap.get(cid);
  }

  function list(): WorkspaceMeta[] {
    return Array.from(metaMap.values());
  }

  async function patchMeta(cid: string, patch: Partial<WorkspaceMeta>): Promise<WorkspaceMeta> {
    const meta = requireMeta(cid);
    // A boilerplate switch must re-materialize the new template on disk, else
    // the workspace keeps running the old AGENTS.md forever. instantiateBoilerplate
    // only rewrites template files (AGENTS.md, .pi/), so kb/, memory/, jobs/ and
    // the transcript survive. Do it before writeMeta: a failed copy must leave
    // meta pointing at the template that is actually on disk.
    if (patch.boilerplate !== undefined && patch.boilerplate !== meta.boilerplate) {
      if (!BOILERPLATES.includes(patch.boilerplate)) {
        throw new Error(`workspace registry: unknown boilerplate "${patch.boilerplate}"`);
      }
      await instantiateBoilerplate(patch.boilerplate, meta.dir);
    }
    // Identity fields are never overwritten by a patch, even if present on it.
    const updated: WorkspaceMeta = { ...meta, ...patch, conversationId: meta.conversationId, dir: meta.dir, createdAt: meta.createdAt };
    writeMeta(updated);
    metaMap.set(cid, updated);
    return updated;
  }

  async function appendTranscript(cid: string, entry: TranscriptEntry): Promise<void> {
    const meta = requireMeta(cid);
    appendJsonl(wsPaths(meta.dir).transcript, entry);
  }

  async function transcriptTail(cid: string, n: number): Promise<string[]> {
    const meta = requireMeta(cid);
    const file = wsPaths(meta.dir).transcript;
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const parsed: TranscriptEntry[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Partial<TranscriptEntry>;
        if (typeof obj.ts === "number" && typeof obj.senderId === "string" && typeof obj.text === "string") {
          parsed.push({ ts: obj.ts, senderId: obj.senderId, senderName: obj.senderName, text: obj.text });
        }
      } catch {
        /* skip corrupt/partial line — tail must tolerate a truncated last write */
      }
    }
    if (n <= 0) return [];
    return parsed.slice(-n).map((e) => `${formatHHMM(e.ts, cfg.timezone)} ${e.senderName ?? e.senderId}: ${e.text}`);
  }

  async function kbSave(entry: Omit<KbEntry, "id" | "injectedAt" | "revoked">): Promise<KbEntry> {
    const full: KbEntry = { ...entry, id: randomUUID(), injectedAt: nextInjectedAt(), revoked: false };
    if (full.scope === "global") {
      delete full.conversationId; // KbEntry contract: conversationId is set only when scope === "workspace"
      writeKbEntry(paths.sharedKb, full);
      return full;
    }
    if (!full.conversationId) throw new Error("workspace registry: kbSave workspace-scope entry requires conversationId");
    const meta = requireMeta(full.conversationId);
    writeKbEntry(kbDirFor(meta.dir), full);
    return full;
  }

  async function kbPromote(kbId: string, actor: string): Promise<KbEntry | undefined> {
    void actor; // provenance (injectedBy/injectedAt) is kept as the original injector's, per contract
    if (readKbEntry(paths.sharedKb, kbId)) return undefined; // already global
    for (const meta of metaMap.values()) {
      const dir = kbDirFor(meta.dir);
      const entry = readKbEntry(dir, kbId);
      if (!entry) continue;
      const promoted: KbEntry = { ...entry, scope: "global" };
      delete promoted.conversationId;
      writeKbEntry(paths.sharedKb, promoted);
      deleteKbEntry(dir, kbId);
      return promoted;
    }
    return undefined;
  }

  async function kbRevoke(kbId: string, actor: string): Promise<boolean> {
    void actor;
    const sharedEntry = readKbEntry(paths.sharedKb, kbId);
    if (sharedEntry) {
      if (!sharedEntry.revoked) writeKbEntry(paths.sharedKb, { ...sharedEntry, revoked: true });
      return true;
    }
    for (const meta of metaMap.values()) {
      const dir = kbDirFor(meta.dir);
      const entry = readKbEntry(dir, kbId);
      if (!entry) continue;
      if (!entry.revoked) writeKbEntry(dir, { ...entry, revoked: true });
      return true;
    }
    return false;
  }

  async function kbList(cid: string): Promise<KbEntry[]> {
    const meta = requireMeta(cid);
    const wsEntries = readKbEntries(kbDirFor(meta.dir)).filter((e) => !e.revoked);
    const globalEntries = readKbEntries(paths.sharedKb).filter((e) => !e.revoked);
    const overlayQuestions = new Set(wsEntries.map((e) => e.question.trim()));
    return [...wsEntries, ...globalEntries.filter((e) => !overlayQuestions.has(e.question.trim()))];
  }

  async function kbDigest(cid: string): Promise<string> {
    const entries = await kbList(cid); // already workspace-overlay-first
    const parts: string[] = [];
    let total = 0;
    for (const e of entries) {
      const block = `Q: ${e.question}\nA: ${e.answer}`;
      const addLen = block.length + (parts.length ? 2 : 0);
      if (total + addLen > KB_DIGEST_CAP) break;
      parts.push(block);
      total += addLen;
    }
    return parts.join("\n\n");
  }

  async function recordUnanswered(cid: string, question: string, senderId: string): Promise<void> {
    const meta = requireMeta(cid);
    appendJsonl(join(kbDirFor(meta.dir), "unanswered.jsonl"), { ts: Date.now(), question, senderId });
  }

  async function recordEscalation(cid: string, question: string, context: string, senderId: string): Promise<void> {
    const meta = requireMeta(cid);
    appendJsonl(join(kbDirFor(meta.dir), "escalations.jsonl"), { ts: Date.now(), question, context, senderId });
  }

  async function memoryAdmin(cid: string, op: "list" | "read" | "write" | "delete", name?: string, content?: string): Promise<ToolResponse> {
    const meta = requireMeta(cid);
    const dir = memoryDirFor(meta.dir);
    mkdirSync(dir, { recursive: true });

    if (op === "list") {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.slice(0, -3));
      return { ok: true, message: `${files.length} memory file(s)`, data: files };
    }

    if (!name || !MEMORY_NAME_RE.test(name)) {
      return { ok: false, message: "invalid memory file name (letters, digits, - and _ only)" };
    }
    const file = join(dir, `${name}.md`);

    if (op === "read") {
      if (!existsSync(file)) return { ok: false, message: `memory file not found: ${name}` };
      return { ok: true, message: `read ${name}`, data: readFileSync(file, "utf8") };
    }
    if (op === "write") {
      if (content === undefined) return { ok: false, message: "content required for write" };
      writeFileAtomic(file, content);
      return { ok: true, message: `wrote ${name}` };
    }
    // op === "delete"
    if (!existsSync(file)) return { ok: false, message: `memory file not found: ${name}` };
    unlinkSync(file);
    return { ok: true, message: `deleted ${name}` };
  }

  return {
    getOrCreate,
    get,
    list,
    patchMeta,
    appendTranscript,
    transcriptTail,
    kbSave,
    kbPromote,
    kbRevoke,
    kbList,
    kbDigest,
    recordUnanswered,
    recordEscalation,
    memoryAdmin,
  };
}
