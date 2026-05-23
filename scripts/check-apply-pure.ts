#!/usr/bin/env bun
/**
 * INV-Kernel-3 compliance check: verify extension apply() functions
 * contain no top-level await (pure synchronous registration).
 *
 * apply() may return hooks containing async functions (kernelReady, etc.)
 * but apply() itself must not perform IO.
 */
import { Project, SyntaxKind, type Node } from 'ts-morph';

const violations: string[] = [];
const v = (msg: string) => violations.push(msg);

const project = new Project({ tsConfigFilePath: 'tsconfig.json', skipAddingFilesFromTsConfig: false });

const FUNCTION_KINDS = new Set([
  SyntaxKind.ArrowFunction,
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.MethodDeclaration,
]);

/**
 * Walk up from node until we hit `stopAt`.
 * Return true if we see a function boundary before `stopAt`.
 */
function isInsideNestedFunction(node: Node, stopAt: Node): boolean {
  let current: Node | undefined = node.getParent();
  while (current && current !== stopAt) {
    if (FUNCTION_KINDS.has(current.getKind())) return true;
    current = current.getParent();
  }
  return false;
}

for (const f of project.getSourceFiles('src/extensions/*/index.ts')) {
  const defineCalls = f.getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter(c => c.getExpression().getText().endsWith('defineExtension'));

  for (const call of defineCalls) {
    const arg = call.getArguments()[0];
    if (!arg) continue;

    const objLiteral = arg.asKind(SyntaxKind.ObjectLiteralExpression)
      ?? arg.getFirstChildByKind(SyntaxKind.ObjectLiteralExpression);
    if (!objLiteral) continue;

    const applyProp = objLiteral.getProperty('apply');
    if (!applyProp) continue;

    const applyFnNode = applyProp.getLastChild();
    if (!applyFnNode) continue;

    const applyBody = applyFnNode.getFirstChildByKind(SyntaxKind.Block)
      ?? applyFnNode.asKind(SyntaxKind.Block);
    if (!applyBody) continue;

    // Find all AwaitExpressions, exclude those inside nested functions
    const allAwaits = applyBody.getDescendantsOfKind(SyntaxKind.AwaitExpression);
    for (const awaitExpr of allAwaits) {
      if (!isInsideNestedFunction(awaitExpr, applyBody)) {
        v(`[INV-Kernel-3] ${f.getFilePath()}:${awaitExpr.getStartLineNumber()} — apply() contains top-level await. Move async IO to kernelReady hook.`);
        break; // One violation per file is enough
      }
    }

    // Check for fire-and-forget .then()/.catch() at top level
    for (const stmt of applyBody.getStatements()) {
      const fnNodes = stmt.getDescendantsOfKind(SyntaxKind.ArrowFunction);
      // Remove text of nested functions, then check remaining text for .then()/.catch()
      let remaining = stmt.getFullText();
      for (const fn of fnNodes) {
        remaining = remaining.replace(fn.getFullText(), '');
      }
      if (/\.\s*then\s*\(/.test(remaining)) {
        v(`[INV-Kernel-3] ${f.getFilePath()}:${stmt.getStartLineNumber()} — apply() contains fire-and-forget .then() chain. Move async IO to kernelReady hook.`);
      }
    }
  }
}

if (violations.length) {
  console.error('\n❌ apply() purity violations (INV-Kernel-3):\n');
  violations.forEach(x => console.error('  ' + x));
  console.error(`\n${violations.length} violation(s). apply() must be pure synchronous registration.\n`);
  process.exit(1);
}
console.log('✅ All extension apply() functions are pure (INV-Kernel-3)');
