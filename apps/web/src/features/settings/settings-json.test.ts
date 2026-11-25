import { describe, expect, test } from "bun:test";
import {
  looksLikeSecret,
  parseSettingsDocument,
  reasonText,
  SETTING_SPECS,
  savePlan,
  validateSettings,
} from "./settings-json";

const CURRENT = {
  "dispatch.reuseChildConversation": true,
  proactiveAssessment: { mode: "observe", model: "deepseek/deepseek-v4-pro" },
  "provider.deepseek": { apiKey: "****3e6e" },
  "auth.password_hash": "****abcd",
  "legacy.flag": "x",
};

/** The document the page shows, with `edit` applied on top of `current`. */
function edited(current: Record<string, unknown>, edit: Record<string, unknown>): string {
  return JSON.stringify({ settings: { ...current, ...edit } }, null, 2);
}

function check(raw: string, current: Record<string, unknown> = CURRENT) {
  const parsed = parseSettingsDocument(raw);
  if (!parsed.ok) return parsed;
  return validateSettings(parsed.settings, current);
}

describe("parseSettingsDocument", () => {
  test("accepts the GET /api/settings document", () => {
    const parsed = parseSettingsDocument('{"settings":{"cost.dailyBudgetUsd":5}}');
    expect(parsed.ok).toBeTruthy();
  });

  test("refuses anything that is not one settings object", () => {
    for (const raw of ["[]", '{"settings":[]}', '{"other":{}}', '{"a":{},"settings":{}}', "5"]) {
      const parsed = parseSettingsDocument(raw);
      expect(parsed.ok).toBeFalsy();
    }
  });

  test("a syntax error says where", () => {
    const parsed = parseSettingsDocument('{"settings": {');
    expect(parsed.ok).toBeFalsy();
  });
});

describe("validateSettings", () => {
  test("the document unchanged has nothing to save", () => {
    const result = check(edited(CURRENT, {}));
    expect(result.ok).toBeTruthy();
  });

  test("only the changed keys become changes, each with its stored and new value", () => {
    const result = check(
      edited(CURRENT, {
        "dispatch.reuseChildConversation": false,
        "cost.dailyBudgetUsd": 12.5,
        proactiveAssessment: CURRENT.proactiveAssessment,
      }),
    );
    if (!result.ok) throw new Error("expected a valid candidate");
    expect(result.changes.map((change) => change.key)).toEqual([
      "dispatch.reuseChildConversation",
      "cost.dailyBudgetUsd",
    ]);
    const budget = result.changes.find((change) => change.key === "cost.dailyBudgetUsd");
    expect(budget?.from).toBe("not set");
    expect(budget?.to).toBe("12.5");
  });

  test("a wrong type names the key and what it must be", () => {
    const cases: Array<[string, unknown]> = [
      ["dispatch.reuseChildConversation", "yes"],
      ["cost.dailyBudgetUsd", "5"],
      ["cost.dailyBudgetUsd", -1],
      ["sandbox.networkAllowlist", "example.com"],
      ["sandbox.networkAllowlist", ["example.com", ""]],
      ["proactiveAssessment", { mode: "yolo" }],
      ["proactiveAssessment", { prompt: "…" }],
      ["proactiveAssessment", { model: 7 }],
    ];
    for (const [key, value] of cases) {
      const result = check(edited(CURRENT, { [key]: value }));
      if (result.ok) throw new Error(`${key}: expected a reason`);
      expect(result.reasons[0]?.code).toBe("type");
      expect(result.reasons[0]?.key).toBe(key);
    }
  });

  test("a valid value for every setting the product reads passes its check", () => {
    const good: Record<string, unknown> = {
      "dispatch.reuseChildConversation": false,
      proactiveAssessment: { mode: "auto", model: "deepseek/deepseek-flash" },
      "cost.dailyBudgetUsd": 3,
      "sandbox.networkAllowlist": ["registry.npmjs.org", "github.com"],
    };
    for (const spec of SETTING_SPECS) {
      expect(spec.check(good[spec.key])).toBeNull();
    }
  });

  test("a key the product does not read cannot be added or changed", () => {
    const added = check(edited(CURRENT, { "totally.new": 1 }));
    if (added.ok) throw new Error("expected a reason");
    expect(added.reasons[0]?.code).toBe("unknown");

    const changed = check(edited(CURRENT, { "legacy.flag": "y" }));
    if (changed.ok) throw new Error("expected a reason");
    expect(changed.reasons[0]?.code).toBe("unknown");
  });

  test("credentials another channel owns are refused when changed, left alone when not", () => {
    const changed = check(
      edited(CURRENT, { "provider.deepseek": { apiKey: "sk-plain-secret-value-123456" } }),
    );
    if (changed.ok) throw new Error("expected a reason");
    expect(changed.reasons[0]?.code).toBe("managed");
    expect(changed.reasons[0]?.where).toBe("Models & credentials");

    const untouched = check(edited(CURRENT, {}));
    if (!untouched.ok) throw new Error("expected a valid candidate");
    expect(untouched.untouched).toEqual(["provider.deepseek", "auth.password_hash", "legacy.flag"]);
  });

  test("a plain secret pasted as a value is refused, a host name is not", () => {
    const secret = check(
      edited(CURRENT, { "sandbox.networkAllowlist": ["example.com", "sk-abcdefghijklmnop"] }),
    );
    if (secret.ok) throw new Error("expected a reason");
    expect(secret.reasons[0]?.code).toBe("secret");

    const hosts = check(edited(CURRENT, { "sandbox.networkAllowlist": ["example.com"] }));
    expect(hosts.ok).toBeTruthy();
    expect(looksLikeSecret("example.com")).toBeFalsy();
  });

  test("a stored setting left out of the document is a reason: nothing can delete it", () => {
    const document = JSON.stringify({
      settings: { "cost.dailyBudgetUsd": 5, "provider.deepseek": CURRENT["provider.deepseek"] },
    });
    const result = check(document);
    if (result.ok) throw new Error("expected a reason");
    expect(result.reasons).toEqual([
      { code: "missing", key: "dispatch.reuseChildConversation" },
      { code: "missing", key: "proactiveAssessment" },
    ]);
  });

  test("a reason reads as a sentence that names the key", () => {
    const result = check(edited(CURRENT, { "totally.new": 1 }));
    if (result.ok) throw new Error("expected a reason");
    const text = reasonText(result.reasons[0]!);
    expect(text).toContain("totally.new");
  });
});

describe("savePlan", () => {
  test("a rejected validation has no plan: a managed key or a wrong type never reaches the API", () => {
    const managed = check(
      edited(CURRENT, { "provider.deepseek": { apiKey: "sk-aaaaaaaaaaaaaaaaaaaa" } }),
    );
    expect(managed.ok).toBeFalsy();
    expect(savePlan(managed)).toEqual([]);
    const wrongType = check(edited(CURRENT, { "cost.dailyBudgetUsd": "sk-aaaaaaaaaaaaaaaaaaaa" }));
    expect(wrongType.ok).toBeFalsy();
    expect(savePlan(wrongType)).toEqual([]);
  });

  test("an accepted validation becomes one PUT per change, in document order, values as written", () => {
    const result = check(
      edited(CURRENT, {
        "dispatch.reuseChildConversation": false,
        "cost.dailyBudgetUsd": 5,
        "sandbox.networkAllowlist": ["example.com"],
      }),
    );
    if (result.ok === false) throw new Error("expected changes");
    expect(savePlan(result)).toEqual([
      { key: "dispatch.reuseChildConversation", value: false },
      { key: "cost.dailyBudgetUsd", value: 5 },
      { key: "sandbox.networkAllowlist", value: ["example.com"] },
    ]);
  });
});
