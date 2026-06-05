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

    const first = content.indexOf(oldString);
    if (first === -1) {
      return { content: `oldString not found in ${path}`, isError: true };
    }

    // Check uniqueness: search for a second occurrence after the first
    const second = content.indexOf(oldString, first + oldString.length);
    if (second !== -1) {
      // Count total occurrences for the error message
      let count = 2;
      let pos = second + oldString.length;
      while ((pos = content.indexOf(oldString, pos)) !== -1) {
        count++;
        pos += oldString.length;
      }
      return {
        content: `oldString matches ${count} times in ${path}; narrow the match`,
        isError: true,
      };
    }

    // Single match: replace via slice (avoids O(n) split memory)
    const result = content.slice(0, first) + newString + content.slice(first + oldString.length);
    await Bun.write(path, result);
    return { content: `Edited: ${path}` };
  },
};
