// bun test preload (bunfig.toml [test] preload): runs before every test
// file loads. Keeps network-dependent runtime layers OFF so run-level tests
// never pay model downloads or connect timeouts:
// - OMA_VECTOR_MEMORY=0: no recall/retain mount, no learn/facts double-write
// - OMA_EMBEDDINGS=off:  the fastembed provider refuses instantly (FTS-only)
// Vector-layer unit tests override these locally where they need to.
process.env.OMA_VECTOR_MEMORY = "0";
process.env.OMA_EMBEDDINGS = "off";

// A developer shell that sourced apps/backend/.env exports the PRODUCT's
// classifier pin (`OMA_PERMISSION_CLASSIFIER_MODEL=deepseek/deepseek-v4-pro`).
// Tests build a fake-only model runtime, so that pin asks for a real model it
// cannot resolve and the permission-gate tests go red for an environmental
// reason (2026-11-19). Clear it once for every file; a test that needs a
// classifier pins its own value at runtime.
delete process.env.OMA_PERMISSION_CLASSIFIER_MODEL;
// Same leak, wider: the product's env file also exports the Anthropic proxy
// pair, which is enough to register a provider — so a test that asserts "no
// model provider" succeeded instead of failing on a developer shell.
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_BASE_URL;
