# Breaking Changes — 2026-05-31

## `headless` renamed to `print`

The `my-agent headless` command has been renamed to `my-agent print`.

**Migration:**
```bash
# old
my-agent headless "your prompt"
# new
my-agent print "your prompt"
```

## `-p` / `--profile` removed

Use `-a` / `--agent` instead.

**Migration:**
```bash
# old
my-agent --profile my-agent print "hello"
# new
my-agent --agent my-agent print "hello"
```

## Error rendering change

Errors are now rendered in a friendly format by default.
Pass `--verbose` to see technical details including stack traces.
