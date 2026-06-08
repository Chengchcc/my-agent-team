export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--cream)]">
      <div className="fixed top-0 left-0 right-0 h-0.5 bg-[var(--brass)]" />

      <div className="w-full max-w-sm px-8 animate-fade-in">
        <p className="font-[family-name:var(--font-mono)] text-xs tracking-[0.2em] uppercase text-[var(--warm-gray-dark)] mb-8">
          Observatory
        </p>

        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-medium text-[var(--charcoal)] leading-tight mb-2">
          Agent
          <br />
          Workspace
        </h1>

        <p className="font-[family-name:var(--font-heading)] text-sm text-[var(--warm-gray-dark)] mb-8">
          A quiet place to work with agents
        </p>

        <form action="/api/auth/login" method="POST" className="space-y-5">
          <div>
            <label className="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] uppercase text-[var(--warm-gray-dark)] block mb-2">
              Password
            </label>
            <input
              name="password"
              type="password"
              placeholder="••••••••"
              autoFocus
              className="w-full bg-transparent border-0 border-b border-[var(--border-color)]
                         px-0 py-3 text-[var(--charcoal)] font-[family-name:var(--font-heading)]
                         text-lg placeholder:text-[var(--border-color)]
                         focus:outline-none focus:border-[var(--brass)]
                         transition-colors duration-300"
            />
          </div>

          <button
            type="submit"
            className="w-full border border-[var(--charcoal)] bg-[var(--charcoal)]
                       text-[var(--cream)] py-3 font-[family-name:var(--font-mono)]
                       text-xs tracking-[0.15em] uppercase
                       hover:bg-[var(--brass)] hover:border-[var(--brass)]
                       transition-colors duration-300"
          >
            Enter →
          </button>
        </form>

        <div className="mt-12 pt-6 border-t border-[var(--border-color)]">
          <p className="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.15em] text-[var(--warm-gray-dark)]">
            Mid-Century Observatory &copy; {new Date().getFullYear()}
          </p>
        </div>
      </div>
    </div>
  );
}
