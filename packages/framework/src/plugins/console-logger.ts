import { definePlugin } from "../plugin.js";

export function consoleLogger() {
  return definePlugin({
    name: "consoleLogger",
    hooks: {
      afterModel(ctx, messages) {
        const last = messages.at(-1);
        if (last?.role === "assistant") {
          console.log(`[${ctx.threadId}] model done`);
        }
      },
      afterTool(ctx, call, result) {
        console.log(`[${ctx.threadId}] tool ${call.name}: ${result.is_error ? "error" : "ok"}`);
      },
    },
  });
}
