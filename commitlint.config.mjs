/** @type {import("@commitlint/types").UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  plugins: [(await import("./commitlint-plugin-no-cjk.mjs")).default],
  rules: {
    // Prohibit Chinese characters (CJK) in commit messages
    "no-cjk": [2, "never"],
    // Mandatory scope
    "scope-enum": [
      2,
      "always",
      [
        // Packages
        "core",
        "message",
        "api-contract",
        "config",
        "conversation",
        "framework",
        "ai",
        "harness",
        "loop",
        "adapter-mcp",
        "agent-fs",
        "tools-common",
        "runner-protocol",
        "runner-daemon",
        "runtime-observability",
        "test-helpers",
        // Plugins
        "plugin-fs-memory",
        "plugin-goal",
        "plugin-identity",
        "plugin-progressive-skill",
        "plugin-todo",
        "plugin-conversation-context",
        // Apps
        "backend",
        "web",
        "lark-bot",
        // Features
        "cron",
        "mcp",
        "conversation",
        "settings",
        "docs",
        "test",
        "lint",
        "build",
        "deps",
        "repo",
      ],
    ],
    // Scope is required (never empty)
    "scope-empty": [2, "never"],
    // Subject must not be empty
    "subject-empty": [2, "never"],
    // Type must be valid
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "refactor", "perf", "style", "test", "docs", "chore", "ci", "revert"],
    ],
    // Allow technical terms with uppercase abbreviations (P10, CAS, SQL, etc.)
    "subject-case": [0],
    // Subject max length
    "subject-max-length": [2, "always", 100],
    // Body leading blank
    "body-leading-blank": [2, "always"],
  },
};
