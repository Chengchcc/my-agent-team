import { describe, expect, test } from "bun:test";
import { ptyConsoleCommand, ptyWrap } from "./bash-pty.js";

/** The two script dialects. The Darwin form is not stylistic: BSD script
 *  execs `command args...` argv-style, so a quoted shell string used to be
 *  taken as a binary literally named "echo hi" — the pty console exited 1
 *  on every macOS invocation. It must ride through `bash -c` explicitly. */
describe("ptyWrap dialects", () => {
  test("darwin: argv-style through bash -c", () => {
    expect(ptyWrap("echo hi", { platform: "darwin", scriptPath: "/usr/bin/script" })).toBe(
      "/usr/bin/script -q /dev/null bash -c 'echo hi'",
    );
  });

  test("linux: util-linux single-string -c form", () => {
    expect(ptyWrap("echo hi", { platform: "linux", scriptPath: "/usr/bin/script" })).toBe(
      "/usr/bin/script -qec 'echo hi' /dev/null",
    );
  });

  test("quotes survive inside the command", () => {
    expect(ptyWrap("echo 'a b'", { platform: "darwin", scriptPath: "/usr/bin/script" })).toBe(
      "/usr/bin/script -q /dev/null bash -c 'echo '\\''a b'\\'''",
    );
  });

  test("no script binary → null (caller falls back)", () => {
    expect(ptyWrap("echo hi", { platform: "darwin", scriptPath: null })).toBeNull();
  });

  test("ptyConsoleCommand prefixes the stty sizing", () => {
    expect(
      ptyConsoleCommand("vim", 80, 24, { platform: "linux", scriptPath: "/usr/bin/script" }),
    ).toBe("stty rows 24 cols 80; /usr/bin/script -qec 'vim' /dev/null");
  });
});
