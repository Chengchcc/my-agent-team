# KernelContext Static-Only Principle

**KernelContext must only hold startup-time immutable snapshots.**

Runtime-mutable state (agent record, lark config, identity status) must be
exposed via extension capabilities. Extensions read mutable state through
`ctx.extensions.get('xxx').current()`.

Do not add mutable fields to KernelContext. Do not write to KernelContext
from extensions.

Exceptions: `logger` and `bus` are immutable sinks, not "state."
