/** @type {import("@commitlint/types").UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Mandatory scope
    "scope-enum": [
      2,
      "always",
      [
        // Packages
        "core",
        "message",
        "conversation",
        "framework",
        "adapter-anthropic",
        "harness",
        "agent-fs",
        "tools-common",
        "runner-protocol",
        "runner-daemon",
        "runtime-observability",
        "test-helpers",
        // Plugins
        "plugin-fs-memory",
        "plugin-progressive-skill",
        "plugin-task-guard",
        // Apps
        "backend",
        "web",
        "lark-bot",
        // Meta
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
