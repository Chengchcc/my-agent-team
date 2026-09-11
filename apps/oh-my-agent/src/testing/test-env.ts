// bun test preload (bunfig.toml [test] preload): runs before every test
// file loads. Keeps network-dependent runtime layers OFF so run-level tests
// never pay model downloads or connect timeouts:
// - OMA_VECTOR_MEMORY=0: no recall/retain mount, no learn/facts double-write
// - OMA_EMBEDDINGS=off:  the fastembed provider refuses instantly (FTS-only)
// Vector-layer unit tests override these locally where they need to.
process.env.OMA_VECTOR_MEMORY = "0";
process.env.OMA_EMBEDDINGS = "off";
