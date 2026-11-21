import type { Deliverable, Reversibility, Verb } from "./intent.js";

/** ADR 0056: the decision corpus. Every entry is a real-shaped request with
 *  the answer the product wants, so a change to the facet tables or the slot
 *  map has something to break against.
 *
 *  This is deliberately data, not prose: the deterministic test below reads
 *  it, and `scripts/golden-intent.ts` replays the same entries against a real
 *  model when one is configured. Adding a case costs one object; that is the
 *  point — the corpus grows with the product instead of being rewritten. */
export type GoldenCase = {
  readonly id: string;
  readonly message: string;
  readonly why: string;
  readonly expected:
    | { readonly action: "answer" }
    | {
        readonly action: "ask";
        readonly verb: Verb;
        readonly deliverable: Deliverable;
        readonly slots: Readonly<Record<string, string>>;
        /** Gaps the human must fill, in table order. */
        readonly missing: readonly string[];
      }
    | {
        readonly action: "dispatch";
        readonly verb: Verb;
        readonly deliverable: Deliverable;
        readonly slots: Readonly<Record<string, string>>;
        readonly references?: readonly string[];
        readonly reversibility?: Reversibility;
        /** A complete brief that still may not leave the desk without a human. */
        readonly needsHuman?: boolean;
      }
    | {
        /** One utterance, several briefs — the decomposition the fixture
         *  exists to prove is possible at all. */
        readonly action: "multi";
        readonly briefs: ReadonlyArray<{ readonly verb: Verb; readonly deliverable: Deliverable }>;
      };
};

export const GOLDEN_INTENT_CASES: readonly GoldenCase[] = [
  {
    id: "answer-error-meaning",
    message: "这个报错是什么意思：ECONNREFUSED 127.0.0.1:5432",
    why: "解释一个错误是 answer，不是派单——它不改变世界，也不需要验收标准",
    expected: { action: "answer" },
  },
  {
    id: "answer-smalltalk",
    message: "你好",
    why: "问候永远不该变成一次执行：默认动作是回答",
    expected: { action: "answer" },
  },
  {
    id: "answer-runtime",
    message: "你的 runtime 是什么",
    why: "关于自己的问题，一句话就能答",
    expected: { action: "answer" },
  },
  {
    id: "answer-english-docs",
    message: "Which docs zone answers deployment questions?",
    why: "英文提问同样按语义判，不按语言",
    expected: { action: "answer" },
  },
  {
    id: "ask-fix-thin",
    message: "点登录一直转圈，帮我修一下",
    why: "只有现象，没有范围与验收标准——派出去工人只能猜",
    expected: {
      action: "ask",
      verb: "fix",
      deliverable: "change",
      // "转圈" is the symptom, not reproduction steps: a repro says HOW to
      // make it happen. Annotating it as supplied would teach the model to
      // accept a symptom as a procedure.
      slots: {},
      missing: ["repro", "expected", "scope", "acceptance"],
    },
  },
  {
    id: "dispatch-fix-ready",
    message:
      "点登录转圈：复现是打开 /login 点提交；期望进入首页；只改 src/auth/**；验收是 bun test src/auth 通过",
    why: "四格齐全才允许离开前台",
    expected: {
      action: "dispatch",
      verb: "fix",
      deliverable: "change",
      slots: {
        repro: "打开 /login 点提交",
        expected: "进入首页",
        scope: "src/auth/**",
        acceptance: "bun test src/auth 通过",
      },
    },
  },
  {
    id: "ask-review-thin",
    message: "评审一下这个 diff",
    why: "评审不需要范围，但需要有对象和标准",
    expected: {
      action: "ask",
      verb: "review",
      deliverable: "report",
      slots: {},
      missing: ["target", "criteria"],
    },
  },
  {
    id: "dispatch-review-ready",
    message: "评审 PR #42，标准是正确性、可读性、是否有测试",
    why: "评审的槽位里没有 scope——这正是维度化要表达的事",
    expected: {
      action: "dispatch",
      verb: "review",
      deliverable: "report",
      slots: { target: "PR #42", criteria: "正确性、可读性、是否有测试" },
      references: ["#42"],
    },
  },
  {
    // Was "ask-investigate-thin" (missing sources/stop => ask). Live evidence
    // 2026-11-21: the front desk tried to dispatch a project investigation
    // three times, collected "investigate needs sources / needs stop", and
    // answered the question itself. Sources and stopping points are NOT
    // human-only knowledge — the worker finds the sources and its budget ends
    // the search — so a thin investigation is dispatched, and the worker asks
    // upward only if it truly cannot start.
    id: "dispatch-investigate-thin",
    message: "为什么 nightly 报告昨天没发出来",
    why: "疑问句 + 没有证据源：来源是工人能找到的，不是人要回答的——派出去",
    expected: {
      action: "dispatch",
      verb: "investigate",
      deliverable: "report",
      slots: { question: "nightly 报告昨天没发出来" },
    },
  },
  {
    id: "dispatch-investigate-ready",
    message: "查 nightly 为什么没发，日志在 /var/log/nightly，找到根因就停",
    why: "有证据源、有停止条件，才是一次可交付的调查",
    expected: {
      action: "dispatch",
      verb: "investigate",
      deliverable: "report",
      slots: {
        question: "nightly 为什么没发",
        sources: "/var/log/nightly",
        stop: "找到根因",
      },
    },
  },
  {
    id: "ask-write-thin",
    message: "给新同事写一份上手文档，面向后端，1000 字左右",
    why: "对象和形态都有，缺素材来源——写手编不出你的项目",
    expected: {
      action: "ask",
      verb: "write",
      deliverable: "report",
      slots: { audience: "新同事（后端）", form: "1000 字左右" },
      missing: ["source"],
    },
  },
  {
    id: "dispatch-write-ready",
    message: "给新同事写上手文档，面向后端，1000 字左右，素材用 docs/architecture",
    why: "素材指定之后，这份活可以交出去",
    expected: {
      action: "dispatch",
      verb: "write",
      deliverable: "report",
      slots: { audience: "新同事（后端）", form: "1000 字左右", source: "docs/architecture" },
    },
  },
  {
    id: "ask-build-thin",
    message: "加一个导出 CSV 的按钮，范围是 web 的设置页，验收是导出的文件能打开",
    why: "约束没给——「不要引入新依赖」这种事必须有人先说",
    expected: {
      action: "ask",
      verb: "build",
      deliverable: "change",
      slots: {
        goal: "加一个导出 CSV 的按钮",
        scope: "web 的设置页",
        acceptance: "导出的文件能打开",
      },
      missing: ["constraints"],
    },
  },
  {
    id: "dispatch-build-ready",
    message: "加导出 CSV 按钮，范围 web 设置页，验收是导出文件能打开，不要引入新依赖",
    why: "加一条约束就齐了；约束常常是「不要做什么」",
    expected: {
      action: "dispatch",
      verb: "build",
      deliverable: "change",
      slots: {
        goal: "加导出 CSV 按钮",
        scope: "web 设置页",
        acceptance: "导出文件能打开",
        constraints: "不要引入新依赖",
      },
    },
  },
  {
    id: "ask-operate-thin",
    message: "重启 staging 的 api",
    why: "动环境可以，但回滚方式是必须知道的——出事时没人现编",
    expected: {
      action: "ask",
      verb: "operate",
      deliverable: "state-change",
      slots: { environment: "staging", action: "重启 api" },
      missing: ["rollback"],
      ...{},
    },
  },
  {
    id: "dispatch-operate-reversible",
    message: "重启 staging 的 api，出问题就重新部署 v1.18 回来",
    why: "可逆的操作补齐回滚后可以派；不需要人当场再点一次头",
    expected: {
      action: "dispatch",
      verb: "operate",
      deliverable: "state-change",
      slots: { environment: "staging", action: "重启 api", rollback: "重新部署 v1.18" },
      reversibility: "reversible",
    },
  },
  {
    id: "dispatch-operate-irreversible",
    message: "在生产重启 api，回滚方式是发布 v1.19 镜像回滚",
    why: "信息齐了，但不可逆——只有这一轮的人类能授权",
    expected: {
      action: "dispatch",
      verb: "operate",
      deliverable: "state-change",
      slots: { environment: "生产", action: "重启 api", rollback: "发布 v1.19 镜像回滚" },
      reversibility: "irreversible",
      needsHuman: true,
    },
  },
  {
    id: "multi-fix-and-doc",
    message: "修登录转圈，顺手把 README 的登录章节也更新一下",
    why: "一句话两件事 = 两个 brief；合成一个会让工人挑容易的做",
    expected: {
      action: "multi",
      briefs: [
        { verb: "fix", deliverable: "change" },
        { verb: "write", deliverable: "report" },
      ],
    },
  },
  {
    id: "ask-ellipsis",
    message: "那个还没修好吗",
    why: "回指没有先行语时，先问「哪个」；不能拿最近一条记忆硬套",
    expected: {
      action: "ask",
      verb: "fix",
      deliverable: "change",
      slots: {},
      missing: ["repro", "expected", "scope", "acceptance"],
    },
  },
  {
    id: "answer-remembered-question",
    message: "按上次说的分支来就行",
    why: "记忆能补槽位，但不改变动作本身：这仍是一次 build 的收尾询问",
    expected: {
      action: "ask",
      verb: "build",
      deliverable: "change",
      slots: {},
      missing: ["goal", "scope", "acceptance", "constraints"],
    },
  },
];
