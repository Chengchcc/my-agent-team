export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--canvas)]">
      <div className="fixed top-0 left-0 right-0 h-0.5 bg-[var(--primary)]" />

      <div className="w-full max-w-sm px-8 animate-fade-in">
        <p className="text-xs tracking-[2.52px] uppercase text-[var(--mute)] mb-8 font-[family-name:var(--font-sans)] font-semibold">
          Observatory
        </p>

        <h1
          className="text-3xl font-normal text-[var(--ink-strong)] leading-tight mb-2 font-[family-name:var(--font-sans)]"
          style={{ letterSpacing: "-0.65px" }}
        >
          Agent
          <br />
          Workspace
        </h1>

        <p className="text-sm text-[var(--body)] mb-8">A terminal for working with agents</p>

        <form action="/api/auth/login" method="POST" className="space-y-5">
          <div>
            <label className="text-[10px] tracking-[2.52px] uppercase text-[var(--mute)] block mb-2 font-[family-name:var(--font-sans)] font-semibold">
              Password
            </label>
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              className="w-full bg-transparent border-0 border-b border-[var(--hairline)]
                         px-0 py-3 text-[var(--ink)] text-base
                         placeholder:text-[var(--mute)]
                         focus:outline-none focus:border-[var(--primary)] focus-visible:ring-0
                         transition-colors duration-200"
            />
          </div>

          <button
            type="submit"
            className="w-full bg-[var(--primary)] text-[var(--on-primary)]
                       rounded-md py-3 text-sm font-semibold
                       hover:opacity-90 focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--canvas)]
                       transition-opacity duration-200"
          >
            Enter &rarr;
          </button>
        </form>

        <div className="mt-12 pt-6 border-t border-[var(--hairline)]">
          <p className="text-[10px] tracking-[0.15em] text-[var(--mute)]">
            VoltAgent Terminal &copy; {new Date().getFullYear()}
          </p>
        </div>
      </div>
    </div>
  );
}
