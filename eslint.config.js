import tseslint from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';

// ── INV-Ext-Comm-1: cross-extension import enforcement ──
const ALL_EXTENSIONS = [
  'controlplane', 'dataplane', 'evolution', 'frontend.lark', 'frontend.tui',
  'identity', 'mcp', 'memory', 'permission', 'provider', 'session', 'skills',
  'tools', 'trace', 'transport.inmem', 'transport.unix',
];

const CROSS_EXT_MSG =
  'Cross-extension imports prohibited (INV-Ext-Comm-1). ' +
  'Communicate via ctx.extensions.get / ctx.bus / hooks instead.';

/**
 * Build overrides so that files within each extension can import from:
 *  - their own extension directory
 *  - kernel/, domain/, application/, infrastructure/, shared/, utils/, config/
 * but NOT from other extension directories.
 */
function buildExtensionOverrides() {
  const overrides = [];

  for (const ext of ALL_EXTENSIONS) {
    // All OTHER extension paths to block
    const otherExtPatterns = ALL_EXTENSIONS
      .filter(e => e !== ext)
      .map(e => `**/extensions/${e}/**`);

    overrides.push({
      files: [`src/extensions/${ext}/**`],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: [{
            group: otherExtPatterns,
            message: CROSS_EXT_MSG,
          }],
        }],
      },
    });
  }

  return overrides;
}

export default [
  // ===== Base TS config =====
  {
    files: ['src/**/*.{ts,tsx}', 'bin/**/*.ts'],
    languageOptions: {
      parser,
      parserOptions: { project: './tsconfig.json' },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'react-hooks': reactHooks,
      'react': react,
    },
    settings: { react: { version: '18' } },
    rules: {
      // --- typescript-eslint ---
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // --- react-hooks (prevents the ThinkingMessage/ToolCallMessage class of crash) ---
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // --- react ---
      'react/jsx-key': 'error',
      'react/jsx-no-leaked-render': 'error',

      // --- no-restricted-syntax: block deprecated profile* identifiers ---
      'no-restricted-syntax': ['error', {
        selector: "Identifier[name=/^(profileId|profileDir|profileRoot|ProfileStore|ProfilePaths|ProfileRecord|ProfileNotFoundError|ProfileExistsError)$/]",
        message: "Use the 'agent' naming. Profile is deprecated.",
      }],

      // --- base ---
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'complexity': ['error', 25],
      'max-lines-per-function': ['error', { max: 150, skipBlankLines: true, skipComments: true }],
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],

      // --- magic numbers ---
      '@typescript-eslint/no-magic-numbers': ['error', {
        ignore: [-1, 0, 1, 2, 10, 16, 24, 60, 100, 1000, 1024],
        ignoreEnums: true,
        ignoreNumericLiteralTypes: true,
        ignoreReadonlyClassProperties: true,
        ignoreTypeIndexes: true,
        ignoreDefaultValues: true,
        ignoreClassFieldInitialValues: true,
        ignoreArrayIndexes: true,
      }],

      // --- INV-Ext-Comm-1: block imports from extension directories ---
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/extensions/*/**'],
          message: CROSS_EXT_MSG,
        }],
      }],
    },
  },

  // ===== Per-extension overrides: allow same-extension imports =====
  ...buildExtensionOverrides(),

  // ===== A20: application/slash must not import lower layers =====
  // NOTE: expand to src/application/** once usecase→kernel/infrastructure imports are resolved.
  {
    files: ['src/application/slash/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/extensions/**', '**/kernel/**', '**/infrastructure/**', '**/cli/**', '**/interface/**'],
          message:
            'A20: application/ must not import lower layers. Lower layers depend on application; never the reverse.',
        }],
      }],
    },
  },

  // ===== INV-Kernel-1: kernel/ must not import extensions/ =====
  {
    files: ['src/kernel/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/extensions/**'],
          message: 'INV-Kernel-1: kernel/ must not import extensions/. Kernel may import from application/ and domain/ only.',
        }],
      }],
    },
  },

  // ===== INV-Data-7: transport adapters must only depend on ports/contracts =====
  {
    files: ['src/infrastructure/transport/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/extensions/**'],
          message:
            'Transport adapters must not import extensions/** (INV-Data-7). ' +
            'Import from application/contracts/** instead.',
        }],
      }],
    },
  },

  // ===== zod boundary: cross-boundary schemas must come from contracts =====
  // Extensions may use zod internally for private validation.
  // Only the following cross-boundary file patterns are blocked from direct zod import:
  {
    files: [
      'src/extensions/tools/index.ts',        // tool registration (LLM-facing schemas)
      'src/extensions/**/events/**',          // event payload files
      'src/extensions/*/contracts.ts',        // contract-typed module barrels
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['zod'],
          message:
            'Cross-boundary schemas must come from application/contracts/**. ' +
            'For ext-internal validation, zod is allowed elsewhere in this extension.',
        }],
      }],
    },
  },

  // ===== Test files — relax strict rules =====
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-magic-numbers': 'off',
      'no-restricted-imports': 'off',
    },
  },

  // ===== Deprecated profile aliases — allowed in compat code =====
  {
    files: [
      'src/infrastructure/paths/migrate-profile-to-agent.ts',
      'src/infrastructure/paths/agent-paths.ts',
      'src/interface/daemon/parse-daemon-args.ts',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },

  // ===== Config defaults — values are self-documenting via key names =====
  {
    files: ['src/config/defaults.ts', 'src/config/schema.ts'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
    },
  },

  // ===== CLI + daemon interface — block process.exit, restrict console =====
  {
    files: ['src/cli/**/*.ts', 'src/interface/**/*.ts'],
    rules: {
      'no-console': ['error', { allow: ['log'] }],
      'no-restricted-syntax': ['error', {
        selector: "CallExpression[callee.object.name='process'][callee.property.name='exit']",
        message: 'Use CliError + throw; let main.ts handle exit. Allowed only in main.ts catch, prompt-runner.ts cancel paths, and cli-daemon.ts log subprocess passthrough.',
      }],
    },
  },

  // ===== bin scripts — allow console, prohibit infrastructure imports =====
  {
    files: ['bin/**/*.ts'],
    rules: {
      'no-console': 'off',
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/infrastructure/**'],
          message: 'bin/** must not import infrastructure/**. Use bootstrap() + kernel extensions instead.',
        }],
      }],
    },
  },
];
