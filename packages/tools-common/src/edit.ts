import type { Tool } from "@my-agent-team/core";

export const editTool: Tool = {
  name: "edit",
  description:
    "Performs exact string replacement in a file. oldString must match exactly and be unique in the file.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit" },
      oldString: { type: "string", description: "The exact text to replace" },
      newString: { type: "string", description: "The text to replace it with" },
    },
    required: ["path", "oldString", "newString"],
  },
  async execute(input) {
    const { path, oldString, newString } = input as {
      path: string;
      oldString: string;
      newString: string;
    };

    const file = Bun.file(path);
    if (!(await file.exists())) {
      return { content: `File not found: ${path}`, isError: true };
    }

    const content = await file.text();
    const parts = content.split(oldString);

    if (parts.length === 1) {
      return { content: `oldString not found in ${path}`, isError: true };
    }

    if (parts.length > 2) {
      return {
        content: `oldString matches ${parts.length - 1} times in ${path}; narrow the match`,
        isError: true,
      };
    }

    await Bun.write(path, parts.join(newString));
    return { content: `Edited: ${path}` };
  },
};
