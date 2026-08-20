/**
 * Workspace registry tests. Drives the real registry against a mkdtemp
 * DOUSHABAO_ROOT — no mocking of our own modules.
 *
 * DOUSHABAO_ROOT is read once by src/shared/paths.ts at module load, so it
 * must be set before that module (or anything importing it) is loaded.
 * Hence the dynamic imports below, after the env var is set, all sharing one
 * tmp root for the whole file. Vitest gives each test file its own process,
 * so this file normally wins that one-time load; if it ever shares a process
 * with a file that sets DOUSHABAO_ROOT first, seedExpertFixture below
 * covers it — every path derivation after the import still goes through the
 * imported `paths` object, never the locally-remembered `ROOT` string, so
 * this file stays internally consistent regardless of who won.
 */
import { afterAll, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "doushabao-workspace-"));
process.env.DOUSHABAO_ROOT = ROOT;

const { paths, wsPaths } = await import("../shared/paths.ts");
const { ConfigSchema } = await import("../shared/types.ts");
const { createWorkspaceRegistry } = await import("./index.ts");
type WorkspaceMeta = import("../shared/types.ts").WorkspaceMeta;

// getOrCreate delegates to src/pi's instantiateExpert, which copies
// experts/<name>/AGENTS.md + .pi/settings.json + the shared extension
// from paths.experts. src/shared/paths.ts bakes ROOT from
// DOUSHABAO_ROOT once per process, so if this file ever shares one with
// another test file, `paths` above may be bound to that file's root
// (whoever imported it first) rather than this file's own ROOT. Seed the fixture
// under wherever `paths.experts` really points, and only if nothing is
// there yet — when it resolves to the real repo experts/ (already
// populated), this must be a no-op, not a clobber.
function seedExpertFixture(): void {
  const general = join(paths.experts, "general");
  if (!existsSync(join(general, "AGENTS.md"))) {
    mkdirSync(join(general, ".pi"), { recursive: true });
    writeFileSync(join(general, "AGENTS.md"), "# General expert\n");
    writeFileSync(join(general, ".pi", "settings.json"), "{}\n");
  }
  const qaCs = join(paths.experts, "qa-cs");
  if (!existsSync(join(qaCs, "AGENTS.md"))) {
    mkdirSync(join(qaCs, ".pi"), { recursive: true });
    writeFileSync(join(qaCs, "AGENTS.md"), "# QA/CS expert\n");
    writeFileSync(join(qaCs, ".pi", "settings.json"), '{"qa": true}\n');
  }
  const sharedExt = join(paths.experts, "_shared", "extensions");
  if (!existsSync(join(sharedExt, "doushabao.ts"))) {
    mkdirSync(sharedExt, { recursive: true });
    writeFileSync(join(sharedExt, "doushabao.ts"), "// fixture extension\n");
  }
}
seedExpertFixture();

const cfg = ConfigSchema.parse({ timezone: "Asia/Shanghai" });

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/** Seed a workspace directory on disk exactly as getOrCreate would, without
 * going through instantiateExpert (owned by src/pi) — lets every method
 * other than getOrCreate itself be tested independent of that module. */
function seedWorkspace(cid: string, overrides: Partial<WorkspaceMeta> = {}): WorkspaceMeta {
  const dir = join(paths.workspaces, cid.replace(/[^a-z0-9]/gi, "_"));
  for (const sub of ["jobs", "kb", "media", "memory"]) mkdirSync(join(dir, sub), { recursive: true });
  const meta: WorkspaceMeta = {
    conversationId: cid,
    conversationType: "group",
    dir,
    expert: "general",
    editors: [],
    multimodal: false,
    digestsEnabled: false,
    createdAt: Date.now(),
    greeted: false,
    ...overrides,
  };
  writeFileSync(wsPaths(dir).meta, JSON.stringify(meta, null, 2));
  return meta;
}

describe("creation + layout (getOrCreate, via src/pi)", () => {
  test("creates a general workspace with the expected on-disk layout, idempotently", async () => {
    const reg = createWorkspaceRegistry(cfg);
    const { meta, created } = await reg.getOrCreate("cid-create-1", "group");
    expect(created).toBe(true);
    expect(meta.conversationId).toBe("cid-create-1");
    expect(meta.conversationType).toBe("group");
    expect(meta.expert).toBe("general");
    expect(meta.editors).toEqual([]);
    expect(meta.multimodal).toBe(false);
    expect(meta.digestsEnabled).toBe(false);
    expect(meta.greeted).toBe(false);
    for (const sub of ["jobs", "kb", "media", "memory"]) {
      expect(existsSync(join(meta.dir, sub))).toBe(true);
    }
    expect(existsSync(wsPaths(meta.dir).meta)).toBe(true);

    const again = await reg.getOrCreate("cid-create-1", "group");
    expect(again.created).toBe(false);
    expect(again.meta.dir).toBe(meta.dir);
  });

  test("concurrent getOrCreate for the same new cid does not race", async () => {
    const reg = createWorkspaceRegistry(cfg);
    const [a, b] = await Promise.all([reg.getOrCreate("cid-create-race", "dm"), reg.getOrCreate("cid-create-race", "dm")]);
    expect(a.meta.dir).toBe(b.meta.dir);
  });
});

describe("get / list", () => {
  test("returns seeded workspaces after a scan at construction", () => {
    seedWorkspace("cid-list-1");
    seedWorkspace("cid-list-2", { conversationType: "dm" });
    const reg = createWorkspaceRegistry(cfg);
    expect(reg.get("cid-list-1")?.conversationId).toBe("cid-list-1");
    expect(reg.get("cid-list-2")?.conversationType).toBe("dm");
    expect(reg.get("does-not-exist")).toBeUndefined();
    const ids = reg.list().map((m) => m.conversationId);
    expect(ids).toContain("cid-list-1");
    expect(ids).toContain("cid-list-2");
  });
});

describe("patchMeta", () => {
  test("persists a patch and protects identity fields", async () => {
    const meta = seedWorkspace("cid-patch-1");
    const reg = createWorkspaceRegistry(cfg);
    const updated = await reg.patchMeta("cid-patch-1", { editors: ["u1"], owner: "u1", digestsEnabled: true, conversationId: "hijack" as never, dir: "/nope" as never });
    expect(updated.editors).toEqual(["u1"]);
    expect(updated.owner).toBe("u1");
    expect(updated.digestsEnabled).toBe(true);
    expect(updated.conversationId).toBe("cid-patch-1");
    expect(updated.dir).toBe(meta.dir);

    // persisted: a fresh registry re-scanning disk sees the patch
    const reg2 = createWorkspaceRegistry(cfg);
    expect(reg2.get("cid-patch-1")?.editors).toEqual(["u1"]);
  });

  test("throws on unknown conversation id", async () => {
    const reg = createWorkspaceRegistry(cfg);
    await expect(reg.patchMeta("does-not-exist", { owner: "x" })).rejects.toThrow();
  });

  test("switching the expert re-materializes the new template, keeping workspace-local state", async () => {
    const reg = createWorkspaceRegistry(cfg);
    const { meta } = await reg.getOrCreate("cid-patch-bp", "group");
    await reg.appendTranscript("cid-patch-bp", { ts: Date.now(), senderId: "u1", text: "hello" });
    await reg.memoryAdmin("cid-patch-bp", "write", "facts", "# Facts");

    const updated = await reg.patchMeta("cid-patch-bp", { expert: "qa-cs" });
    expect(updated.expert).toBe("qa-cs");

    const agentsMd = readFileSync(wsPaths(meta.dir).agentsMd, "utf8");
    expect(agentsMd).toBe(readFileSync(join(paths.experts, "qa-cs", "AGENTS.md"), "utf8"));
    expect(agentsMd).not.toBe(readFileSync(join(paths.experts, "general", "AGENTS.md"), "utf8"));
    expect(readFileSync(wsPaths(meta.dir).piSettings, "utf8")).toBe(readFileSync(join(paths.experts, "qa-cs", ".pi", "settings.json"), "utf8"));

    // state that is not part of the template survives the switch
    expect(await reg.transcriptTail("cid-patch-bp", 5)).toHaveLength(1);
    expect((await reg.memoryAdmin("cid-patch-bp", "read", "facts")).data).toBe("# Facts");
  });

  test("rejects an unknown expert name, leaving meta and disk on the old template", async () => {
    const reg = createWorkspaceRegistry(cfg);
    const { meta } = await reg.getOrCreate("cid-patch-bp-bad", "group");
    await expect(reg.patchMeta("cid-patch-bp-bad", { expert: "qa_cs" as never })).rejects.toThrow(/unknown expert/);
    expect(reg.get("cid-patch-bp-bad")?.expert).toBe("general");
    expect(createWorkspaceRegistry(cfg).get("cid-patch-bp-bad")?.expert).toBe("general");
    expect(readFileSync(wsPaths(meta.dir).agentsMd, "utf8")).toBe(readFileSync(join(paths.experts, "general", "AGENTS.md"), "utf8"));
  });

  test("a patch that does not change the expert re-materializes nothing", async () => {
    const reg = createWorkspaceRegistry(cfg);
    const { meta } = await reg.getOrCreate("cid-patch-bp-noop", "group");
    writeFileSync(wsPaths(meta.dir).agentsMd, "# hand-edited\n");

    await reg.patchMeta("cid-patch-bp-noop", { owner: "u1" });
    expect(readFileSync(wsPaths(meta.dir).agentsMd, "utf8")).toBe("# hand-edited\n");

    await reg.patchMeta("cid-patch-bp-noop", { expert: "general" });
    expect(readFileSync(wsPaths(meta.dir).agentsMd, "utf8")).toBe("# hand-edited\n");
  });
});

describe("transcript append + tail", () => {
  test("formats HH:MM senderName: text in cfg.timezone and tolerates a truncated last line", async () => {
    seedWorkspace("cid-transcript-1");
    const reg = createWorkspaceRegistry(cfg);
    // 2026-01-01T01:05:00Z == 2026-01-01 09:05 Asia/Shanghai
    const ts1 = Date.parse("2026-01-01T01:05:00Z");
    const ts2 = Date.parse("2026-01-01T01:06:30Z");
    await reg.appendTranscript("cid-transcript-1", { ts: ts1, senderId: "u1", senderName: "Alice", text: "hello" });
    await reg.appendTranscript("cid-transcript-1", { ts: ts2, senderId: "u2", text: "no name" });
    // simulate a partial/corrupt last write (process killed mid-append)
    const file = wsPaths(seedWorkspace("cid-transcript-1").dir).transcript;
    writeFileSync(file, "not json\n", { flag: "a" });

    const tail = await reg.transcriptTail("cid-transcript-1", 10);
    expect(tail).toEqual(["09:05 Alice: hello", "09:06 u2: no name"]);
  });

  test("respects n by returning only the most recent entries", async () => {
    seedWorkspace("cid-transcript-2");
    const reg = createWorkspaceRegistry(cfg);
    for (let i = 0; i < 5; i++) {
      await reg.appendTranscript("cid-transcript-2", { ts: Date.now() + i, senderId: "u1", senderName: "A", text: `msg${i}` });
    }
    const tail = await reg.transcriptTail("cid-transcript-2", 2);
    expect(tail).toHaveLength(2);
    expect(tail[1]).toContain("msg4");
    expect(await reg.transcriptTail("cid-transcript-2", 0)).toEqual([]);
  });

  test("returns empty array when no transcript exists yet", async () => {
    seedWorkspace("cid-transcript-empty");
    const reg = createWorkspaceRegistry(cfg);
    expect(await reg.transcriptTail("cid-transcript-empty", 10)).toEqual([]);
  });
});

describe("KB overlay + promote + revoke", () => {
  test("workspace overlay wins over global on duplicate question text, promote keeps provenance and moves out of the workspace, revoke hides without deleting", async () => {
    seedWorkspace("cid-kb-1");
    seedWorkspace("cid-kb-2");
    const reg = createWorkspaceRegistry(cfg);

    const globalEntry = await reg.kbSave({ question: "What are office hours?", answer: "9-6", scope: "global", injectedBy: "admin1" });
    const overlay = await reg.kbSave({ question: "What are office hours?", answer: "9-6 Beijing time", scope: "workspace", conversationId: "cid-kb-1", injectedBy: "editor1" });
    const wsOnly = await reg.kbSave({ question: "Where is the office?", answer: "Building 3", scope: "workspace", conversationId: "cid-kb-1", injectedBy: "editor1" });

    const listCid1 = await reg.kbList("cid-kb-1");
    // overlay wins: the workspace's own answer, not the global one, for the duplicate question
    const hours = listCid1.find((e) => e.question === "What are office hours?");
    expect(hours?.id).toBe(overlay.id);
    expect(hours?.answer).toBe("9-6 Beijing time");
    expect(listCid1.map((e) => e.id)).toContain(wsOnly.id);

    // a workspace with no overlay for that question sees the global entry
    const listCid2 = await reg.kbList("cid-kb-2");
    expect(listCid2.find((e) => e.question === "What are office hours?")?.id).toBe(globalEntry.id);

    // promote the office-location entry (workspace-only) to global; provenance kept
    const promoted = await reg.kbPromote(wsOnly.id, "admin1");
    expect(promoted).toBeDefined();
    expect(promoted?.scope).toBe("global");
    expect(promoted?.id).toBe(wsOnly.id);
    expect(promoted?.injectedBy).toBe("editor1"); // original injector, not the promoting actor
    expect(promoted?.conversationId).toBeUndefined();

    // promoting again (already global) is a no-op returning undefined
    expect(await reg.kbPromote(wsOnly.id, "admin1")).toBeUndefined();
    // promoting an unknown id returns undefined
    expect(await reg.kbPromote("nope", "admin1")).toBeUndefined();

    // moved, not copied: cid-kb-1's own kb dir no longer shadows it, but it
    // still shows up globally for every workspace including the origin one
    const listCid1After = await reg.kbList("cid-kb-1");
    expect(listCid1After.find((e) => e.id === wsOnly.id)?.scope).toBe("global");

    // revoke hides it from listings but does not destroy the audit trail
    expect(await reg.kbRevoke(wsOnly.id, "admin1")).toBe(true);
    const listAfterRevoke = await reg.kbList("cid-kb-1");
    expect(listAfterRevoke.find((e) => e.id === wsOnly.id)).toBeUndefined();
    expect(await reg.kbRevoke("nope", "admin1")).toBe(false);
  });
});

describe("path traversal via model-supplied ids", () => {
  /** Valid JSON: an unguarded kbPromote parses the target, copies it into the
   * shared KB (where it reaches chat) and then unlinks it. Garbage content
   * would hit kb.ts's corrupt-file catch and the test would pass unfixed. */
  const SECRET = JSON.stringify({ id: "stolen", question: "creds", answer: "sk-live-TOPSECRET", scope: "workspace", injectedBy: "pi", injectedAt: 1, revoked: false });

  /** Plant a target under the tmp ROOT, at the path a traversing id resolves
   * to from a workspace kb dir (ROOT/workspaces/<ws>/kb — three levels down). */
  function plant(...rel: string[]): string {
    const file = join(ROOT, ...rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, SECRET);
    return file;
  }

  /** Every file under the tmp root, sorted. The refusal has to be total: a
   * traversing id must not create, move or unlink a file ANYWHERE — the
   * unguarded kbRevoke, for instance, copies the target it read into whichever
   * workspace kb dir it happened to match from, which is not a path a
   * per-directory assertion would think to look at. */
  function treeSnapshot(dir: string = ROOT, prefix = ""): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...treeSnapshot(join(dir, e.name), rel));
      else out.push(rel);
    }
    return out.sort();
  }

  test("kb_promote refuses a traversing kbId: nothing read, nothing copied into the shared KB, target still on disk", async () => {
    seedWorkspace("cid-traversal-1");
    const reg = createWorkspaceRegistry(cfg);

    const config = plant("config", "doushabao.json"); // ../../../config/doushabao
    const auth = plant(".pi", "agent", "auth.json"); // ../../../.pi/agent/auth
    const before = treeSnapshot();

    // Collect first, assert the effects first: the point of this test is that
    // the target survived untouched, not merely what the call returned.
    const ids = ["../../../config/doushabao", "../../../.pi/agent/auth", "../../../../../.pi/agent/auth", "/etc/passwd", "a/../../../config/doushabao"];
    const results = await Promise.all(ids.map((kbId) => reg.kbPromote(kbId, "admin1").catch(() => "threw")));

    // the credential store was neither copied into the shared KB nor unlinked
    expect(treeSnapshot()).toEqual(before);
    expect(readFileSync(config, "utf8")).toBe(SECRET);
    expect(readFileSync(auth, "utf8")).toBe(SECRET);
    // and the refusal is the graceful "not found", same as any unknown id
    expect(results).toEqual(ids.map(() => undefined));
  });

  test("kb_revoke refuses a traversing kbId and does not write revoked:true back into the target", async () => {
    seedWorkspace("cid-traversal-2");
    const reg = createWorkspaceRegistry(cfg);

    const config = plant("config", "doushabao.json");
    const auth = plant(".pi", "agent", "auth.json");
    const before = treeSnapshot();

    const ids = ["../../../config/doushabao", "../../../.pi/agent/auth", "../../../../../.pi/agent/auth", "/etc/passwd"];
    const results = await Promise.all(ids.map((kbId) => reg.kbRevoke(kbId, "admin1").catch(() => "threw")));

    // no new KB file anywhere: an unguarded revoke reads the target and writes
    // its contents back as a KB entry, which kb_list/kb_digest then serve
    expect(treeSnapshot()).toEqual(before);
    // content, not just existence: revoke rewrites the entry it read
    expect(readFileSync(config, "utf8")).toBe(SECRET);
    expect(readFileSync(auth, "utf8")).toBe(SECRET);
    expect(results).toEqual(ids.map(() => false));
  });

  test("memory_admin refuses a traversing name for read, write and delete, leaving the target intact", async () => {
    seedWorkspace("cid-traversal-3");
    const reg = createWorkspaceRegistry(cfg);

    // memory dir is ROOT/workspaces/<ws>/memory, so ../../../secret lands at ROOT/secret.md
    const secret = join(ROOT, "secret.md");
    writeFileSync(secret, SECRET);
    const before = treeSnapshot();

    const results: boolean[] = [];
    for (const name of ["../../../secret", "../../../.pi/agent/auth", "../escape", "/etc/passwd", "a/b", "..", "."]) {
      for (const op of ["read", "write", "delete"] as const) {
        results.push((await reg.memoryAdmin("cid-traversal-3", op, name, "pwned")).ok);
      }
    }

    expect(treeSnapshot()).toEqual(before);
    expect(readFileSync(secret, "utf8")).toBe(SECRET);
    expect(results.every((ok) => ok === false)).toBe(true);
    // and the refused names never reached the listing either
    expect((await reg.memoryAdmin("cid-traversal-3", "list")).data).toEqual([]);
  });

  test("a workspace directory stays under paths.workspaces however the conversation id is spelled", async () => {
    const reg = createWorkspaceRegistry(cfg);
    for (const cid of ["../../../../etc/passwd", "..", "../evil", "/absolute"]) {
      const { meta } = await reg.getOrCreate(cid, "group");
      expect(meta.dir.startsWith(paths.workspaces + "/"), cid).toBe(true);
    }
  });

  test("a rewritten workspace.json cannot relocate a workspace out of paths.workspaces", () => {
    const meta = seedWorkspace("cid-traversal-meta");
    writeFileSync(wsPaths(meta.dir).meta, JSON.stringify({ ...meta, dir: join(ROOT, ".pi", "agent") }, null, 2));

    const reg = createWorkspaceRegistry(cfg);
    expect(reg.get("cid-traversal-meta")?.dir).toBe(meta.dir);
  });
});

describe("kbDigest", () => {
  test("caps around 4000 chars, dropping the excess, and stays workspace-overlay-first", async () => {
    seedWorkspace("cid-digest-1");
    const reg = createWorkspaceRegistry(cfg);
    const longAnswer = "x".repeat(500);
    // 12 * ~518 chars ≈ 6200 chars of global content — comfortably over the 4000 cap.
    for (let i = 0; i < 12; i++) {
      await reg.kbSave({ question: `global-q${i}`, answer: longAnswer, scope: "global", injectedBy: "admin1" });
    }
    const overlay = await reg.kbSave({ question: "overlay-q", answer: "short overlay answer", scope: "workspace", conversationId: "cid-digest-1", injectedBy: "editor1" });

    const digest = await reg.kbDigest("cid-digest-1");
    expect(digest.length).toBeLessThanOrEqual(4000);
    expect(digest.startsWith(`Q: ${overlay.question}`)).toBe(true);
    // the cap actually bit: not every global entry made it in
    expect(digest).not.toContain("global-q11");
  });
});

describe("recordUnanswered / recordEscalation", () => {
  test("appends jsonl entries under the workspace kb dir", async () => {
    const meta = seedWorkspace("cid-record-1");
    const reg = createWorkspaceRegistry(cfg);
    await reg.recordUnanswered("cid-record-1", "how does X work?", "u1");
    await reg.recordEscalation("cid-record-1", "can we refund?", "colleague asked about refund policy", "u1");

    const { readFileSync } = await import("node:fs");
    const unanswered = readFileSync(join(meta.dir, "kb", "unanswered.jsonl"), "utf8").trim().split("\n");
    expect(unanswered).toHaveLength(1);
    expect(JSON.parse(unanswered[0]!).question).toBe("how does X work?");

    const escalations = readFileSync(join(meta.dir, "kb", "escalations.jsonl"), "utf8").trim().split("\n");
    expect(escalations).toHaveLength(1);
    expect(JSON.parse(escalations[0]!).context).toBe("colleague asked about refund policy");
  });
});

describe("memoryAdmin", () => {
  test("list/read/write/delete round-trip and reject unsafe names", async () => {
    seedWorkspace("cid-memory-1");
    const reg = createWorkspaceRegistry(cfg);

    expect((await reg.memoryAdmin("cid-memory-1", "list")).data).toEqual([]);

    const write = await reg.memoryAdmin("cid-memory-1", "write", "facts", "# Facts\n- foo");
    expect(write.ok).toBe(true);

    const list = await reg.memoryAdmin("cid-memory-1", "list");
    expect(list.data).toEqual(["facts"]);

    const read = await reg.memoryAdmin("cid-memory-1", "read", "facts");
    expect(read.ok).toBe(true);
    expect(read.data).toBe("# Facts\n- foo");

    const badName = await reg.memoryAdmin("cid-memory-1", "read", "../escape");
    expect(badName.ok).toBe(false);

    const missing = await reg.memoryAdmin("cid-memory-1", "read", "nope");
    expect(missing.ok).toBe(false);

    const del = await reg.memoryAdmin("cid-memory-1", "delete", "facts");
    expect(del.ok).toBe(true);
    expect((await reg.memoryAdmin("cid-memory-1", "list")).data).toEqual([]);
  });
});
