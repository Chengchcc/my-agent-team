# ADR 0026: Agent trust model for the local single-user product

Status: accepted

## Context

The audit (2026-08) flagged a fork in the road: is the agent (and the CLI
children it controls) a trusted local process or an untrusted execution
surface? Every security decision downstream — bash tool constraints, MCP
credential storage, login policy — depends on this answer. The product is
today a single-user localhost workbench; the question only becomes
load-bearing when it moves to a LAN or hosted deployment.

## Decision

Current posture: **single-user local product, agents treated as
semi-trusted.** We do not defend against a malicious local user attacking
their own machine, but we DO defend against:

- a prompt-injected agent exfiltrating host secrets it never needed;
- cross-process credential leaks (`ps`, env inheritance, stderr tails);
- drive-by remote access to the web surface.

Concretely, the following are in force:

1. Spawned agent CLIs receive an allowlisted env (`childEnv`), never the
   parent's full environment.
2. Backend auth tokens travel via env, never argv.
3. `read_image` and file tools enforce a workspace sandbox (realpath +
   boundary check).
4. Login fails closed without a configured `MOCK_PASSWORD`; comparison is
   constant-time; failures are rate-limited per IP.
5. Subagent roles (`task` registry) may only narrow the executor's tool
   set, never widen it; model overrides must resolve in the catalog.

Not yet decided (LAN/hosted follow-up, would flip agents to untrusted):

- bash tool command constraints beyond cwd checks;
- encrypted-at-rest MCP env/headers;
- removal of the mock login surface.

Traps recorded from another project's production experience (2026-10-09,
reviewing deepcoldy/botmux — a multi-operator Feishu-to-CLI bridge whose
pitfalls document is a bill for exactly the exposure we have not paid yet;
https://github.com/deepcoldy/botmux). None of these is a task today; each is a
decision to make *before* the surface leaves localhost:

- **OS-level isolation, not cwd checks.** Their answer to "the model can run
  anything" is a real sandbox (bubblewrap / copy-on-write root). Our bash-tool
  constraint work above should pick a comparable boundary, not a longer list of
  forbidden commands.
- **A bot may hold exactly one long-connection app per tenant.** A second
  consumer of the same bot makes event delivery flaky in a way that reads as
  our bug; document the constraint where the bot is configured.
- **Temporary access links are a feature, not an ops step.** If link-based
  access is ever added, rotation/revocation ships with it, and token URLs are
  never pasted into a shared chat.
- **Multi-operator action surfaces need a signed action token.** ADR 0031
  already forbids shipping approval buttons to more than one operator without
  one; their ladder (talk / operate / administer) is a usable shape for the
  authorisation model that token must carry. A worked example exists —
  zarazhangrui/lark-coding-agent-bridge, src/card/callback-auth.ts — and the
  shape is worth copying as-is: an HMAC over a compact payload binding run id,
  scope, chat id, **operator open id**, action and a **policy fingerprint**,
  plus an expiry and a one-shot nonce; verification separates malformed /
  unknown-key / bad-signature / expired / context-mismatch / nonce-replay /
  nonce-revoked, and signing keys rotate by version (sign with the newest,
  verify by the version carried in the payload). The policy fingerprint is the
  detail that earns its keep: changing *who may act* invalidates the buttons
  already sitting in a chat.

## Consequences

- Local-hosted today, with the LAN ticket partially paid (login + secret
  hygiene done).
- When moving to a network, re-review this ADR and upgrade the listed
  follow-ups before exposing the surface.
