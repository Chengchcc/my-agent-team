import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentFS, AgentFsAccessError } from "./agent-fs.js";
import { SharedOnlyAliases } from "./aliases.js";
import { MemoryBackend } from "./backends.js";
import { makeDefaultMounts, makeExternalMount, makeSharedOnlyMounts } from "./mounts.js";

function tmpDir() {
  return path.join(tmpdir(), `wsfs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("AgentFS", () => {
  test("makeDefaultMounts constructs without throwing", () => {
    const fs = new AgentFS({
      mounts: makeDefaultMounts({ sharedRoot: "/tmp/sh", privateRoot: "/tmp/pr" }),
    });
    expect(fs).toBeTruthy();
  });

  test("all mount prefixes are directory prefixes", () => {
    for (const m of makeDefaultMounts({ sharedRoot: "/tmp/sh", privateRoot: "/tmp/pr" })) {
      expect(m.prefix.endsWith("/")).toBe(true);
    }
  });

  test("/SOUL.md → sharedRoot via alias", async () => {
    const sh = tmpDir();
    const pr = tmpDir();
    await mkdir(sh, { recursive: true });
    await mkdir(pr, { recursive: true });
    try {
      const fs = new AgentFS({
        mounts: makeDefaultMounts({ sharedRoot: sh, privateRoot: pr }),
      });
      await fs.write("/SOUL.md", "soul");
      expect(await Bun.file(path.join(sh, "SOUL.md")).text()).toBe("soul");
    } finally {
      await rm(sh, { recursive: true, force: true });
      await rm(pr, { recursive: true, force: true });
    }
  });

  test("/memory/x.md → sharedRoot via alias", async () => {
    const sh = tmpDir();
    const pr = tmpDir();
    await mkdir(sh, { recursive: true });
    await mkdir(pr, { recursive: true });
    try {
      const fs = new AgentFS({
        mounts: makeDefaultMounts({ sharedRoot: sh, privateRoot: pr }),
      });
      await fs.mkdirp("/memory/");
      await fs.write("/memory/x.md", "m");
      expect(await Bun.file(path.join(sh, "memory/x.md")).text()).toBe("m");
    } finally {
      await rm(sh, { recursive: true, force: true });
      await rm(pr, { recursive: true, force: true });
    }
  });

  test("/skills/x → privateRoot via alias", async () => {
    const sh = tmpDir();
    const pr = tmpDir();
    await mkdir(sh, { recursive: true });
    await mkdir(pr, { recursive: true });
    try {
      const fs = new AgentFS({
        mounts: makeDefaultMounts({ sharedRoot: sh, privateRoot: pr }),
      });
      await fs.write("/skills/foo/SKILL.md", "skill");
      expect(await Bun.file(path.join(pr, "skills/foo/SKILL.md")).text()).toBe("skill");
    } finally {
      await rm(sh, { recursive: true, force: true });
      await rm(pr, { recursive: true, force: true });
    }
  });

  test("shared-only blocks private paths", async () => {
    const sh = tmpDir();
    await mkdir(sh, { recursive: true });
    try {
      const fs = new AgentFS({
        mounts: makeSharedOnlyMounts({ sharedRoot: sh }),
        aliases: new SharedOnlyAliases(),
      });
      await fs.write("/SOUL.md", "s");
      expect(await fs.read("/SOUL.md")).toBe("s");
      await expect(fs.read("/tmp/a.txt")).rejects.toThrow("no mount");
    } finally {
      await rm(sh, { recursive: true, force: true });
    }
  });

  test("external prefix overrides", async () => {
    const fs = new AgentFS({
      mounts: [
        makeExternalMount("/mnt/drive/"),
        { prefix: "/private/", domain: "private", backend: new MemoryBackend(), posixRoot: "/tmp" },
      ],
    });
    await fs.write("/mnt/drive/spec.md", "ext");
    expect(await fs.read("/mnt/drive/spec.md")).toBe("ext");
  });

  test("rejects .. escape", async () => {
    const fs = new AgentFS({
      mounts: [
        { prefix: "/private/", domain: "private", backend: new MemoryBackend(), posixRoot: "/tmp" },
      ],
    });
    await expect(fs.read("/../escape.md")).rejects.toThrow(AgentFsAccessError);
  });

  test("write/read/exists/stat/list/remove roundtrip", async () => {
    const mem = new MemoryBackend();
    const fs = new AgentFS({
      mounts: [{ prefix: "/private/", domain: "private", backend: mem, posixRoot: "/tmp" }],
    });
    expect(await fs.exists("/file.md")).toBe(false);
    await fs.write("/file.md", "hello world");
    expect(await fs.exists("/file.md")).toBe(true);
    expect(await fs.read("/file.md")).toBe("hello world");
    expect((await fs.stat("/file.md"))?.size).toBe(11);
    await fs.remove("/file.md");
    expect(await fs.exists("/file.md")).toBe(false);
  });

  test("read-only mount write throws", async () => {
    const mem = new MemoryBackend();
    const ro = {
      read: mem.read.bind(mem),
      list: mem.list.bind(mem),
      stat: mem.stat.bind(mem),
      exists: mem.exists.bind(mem),
    };
    const fs = new AgentFS({ mounts: [{ prefix: "/shared/", domain: "shared", backend: ro }] });
    await expect(fs.write("/SOUL.md", "nope")).rejects.toThrow(AgentFsAccessError);
  });

  test("posixRoots collects from mounts", () => {
    const mem = new MemoryBackend();
    const fs = new AgentFS({
      mounts: [
        { prefix: "/shared/", domain: "shared", backend: mem },
        { prefix: "/private/", domain: "private", backend: mem, posixRoot: "/data/pr" },
      ],
    });
    expect(fs.posixRoots()).toEqual(["/data/pr"]);
  });
});
