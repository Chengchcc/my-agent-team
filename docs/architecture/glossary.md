# Lobster v2.1 — Glossary (normative)

## sessionId
Stable, deterministic id derived from an Anchor via anchorToSessionId.
Never 'main', never 'unknown', never empty. Owned by session extension.
1:1 with a row in sessions table.

## frontendId
Per-process, per-tab identifier of a frontend client. Generated via crypto.randomUUID.
Not persisted. Used only by ControlPlane for attach/detach.

## anchor
Typed discriminated union (src/domain/anchor.ts). The ONLY way to produce a
sessionId. Every adapter that receives external input MUST convert it to an Anchor first.

## turnId
Per-turn id within a session, monotonic. Owned by session extension's startTurn().

## runId
Deprecated v2.1. Was a placeholder alias of turnId. Removed.

## routeKey
Internal routingTable key. Equal to anchorKey(anchor). Never exposed across extensions.
