import { beforeEach, describe, expect, test } from "bun:test";
import { conversationDisplayName } from "./conversation-title";
import { registerLocale, setLocale, t } from "./i18n";

describe("i18n seam", () => {
  beforeEach(() => {
    setLocale("en");
  });

  test("the key IS the English string: missing entry renders the key", () => {
    expect(t("Today")).toBe("Today");
    expect(t("definitely not a key")).toBe("definitely not a key");
  });

  test("a registered dictionary overrides keys for the active locale", () => {
    registerLocale("xx", { Today: "HOY" });
    setLocale("xx");
    expect(t("Today")).toBe("HOY");
    // Untranslated keys stay English even in a translated locale.
    expect(t("Tomorrow")).toBe("Tomorrow");
  });

  test("later registrations merge instead of replace", () => {
    registerLocale("xx", { Today: "HOY" });
    registerLocale("xx", { Done: "HECHO" });
    setLocale("xx");
    expect(t("Today")).toBe("HOY");
    expect(t("Done")).toBe("HECHO");
  });

  test("an unregistered locale falls back to the key", () => {
    setLocale("fr");
    expect(t("Today")).toBe("Today");
  });
});

describe("conversationDisplayName", () => {
  test("title wins over preview", () => {
    expect(conversationDisplayName({ title: "T", lastMessagePreview: "P" })).toBe("T");
  });

  test("whitespace-only values are treated as absent", () => {
    expect(conversationDisplayName({ title: "   ", lastMessagePreview: "P" })).toBe("P");
    expect(conversationDisplayName({ title: "  ", lastMessagePreview: "  " })).toBe(
      "New conversation",
    );
  });

  test("no title and no preview shows the neutral placeholder", () => {
    expect(conversationDisplayName({})).toBe("New conversation");
    expect(conversationDisplayName({ title: null, lastMessagePreview: null })).toBe(
      "New conversation",
    );
  });
});
