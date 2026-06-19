/** @type {import("@commitlint/types").Plugin} */
const noCjkPlugin = {
  rules: {
    "no-cjk": (parsed) => {
      const cjkPattern = /[一-鿿㐀-䶿豈-﫿]/;
      const header = parsed.header ?? "";
      const body = parsed.body ?? "";
      const fullText = `${header}\n${body}`;
      if (cjkPattern.test(fullText)) {
        return [false, "commit message must not contain Chinese characters (CJK)"];
      }
      return [true];
    },
  },
};

export default noCjkPlugin;
