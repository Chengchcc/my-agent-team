import { describe, expect, test } from "bun:test";
import { isIrreversibleRequest, isStatusQuestion } from "./routing-observations.js";

describe("ADR 0075: the two routing boundaries worth counting", () => {
  test("irreversible words are caught", () => {
    for (const text of [
      "把 .backend-data 里所有 agent 的工作区清空",
      "rm -rf /tmp/omtest",
      "把这张表 drop table 掉",
      "reset --hard 到昨天",
    ]) {
      expect(isIrreversibleRequest(text)).toBe(true);
    }
  });

  test("ordinary work words are not irreversible - the signal must stay narrow", () => {
    for (const text of ["把 greet 拆成两个函数", "优化一下这个查询", "给我讲讲它的实现"]) {
      expect(isIrreversibleRequest(text)).toBe(false);
    }
  });

  test("status questions about work already in flight are recognised", () => {
    for (const text of ["刚才那个函数跑通了吗", "那个活到哪了", "结果呢"]) {
      expect(isStatusQuestion(text)).toBe(true);
    }
  });

  test("a new request is not a status question", () => {
    for (const text of ["再加一个 farewell", "修一下登录转圈"]) {
      expect(isStatusQuestion(text)).toBe(false);
    }
  });
});
