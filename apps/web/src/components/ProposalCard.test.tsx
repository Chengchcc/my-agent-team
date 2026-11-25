import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProposalCard } from "./ProposalCard";

const fields = [
  { label: "Name", current: "Agent Workspace", proposed: "Agent Workspace" },
  {
    label: "Repository URL",
    current: "https://example.invalid/a.git",
    proposed: "https://example.invalid/b.git",
  },
  { label: "Default branch", current: "", proposed: "main" },
];

function noop(): void {}

describe("ProposalCard", () => {
  test("shows every field beside the value the form holds now", () => {
    const html = renderToStaticMarkup(
      <ProposalCard author="Personal Agent" fields={fields} onApply={noop} />,
    );
    for (const text of ["Name", "Agent Workspace", "https://example.invalid/b.git", "main"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("Personal Agent");
  });

  test("marks changed and unchanged fields apart", () => {
    const html = renderToStaticMarkup(<ProposalCard author="PA" fields={fields} onApply={noop} />);
    expect(html.match(/data-field-state="changed"/g)).toHaveLength(2);
    expect(html.match(/data-field-state="unchanged"/g)).toHaveLength(1);
    expect(html).toContain("Not set");
  });

  test("says that applying fills the form and saves nothing", () => {
    const html = renderToStaticMarkup(<ProposalCard author="PA" fields={fields} onApply={noop} />);
    expect(html).toContain("Apply to form");
    expect(html).toContain("Nothing is saved until you save.");
    expect(html).not.toMatch(/<button[^>]*\sdisabled[\s=>]/);
  });

  test("a stale suggestion cannot be applied and says why", () => {
    const html = renderToStaticMarkup(
      <ProposalCard author="PA" fields={fields} onApply={noop} onDiscard={noop} stale />,
    );
    expect(html).toContain("data-stale");
    expect(html).toContain("no longer describes the draft");
    expect(html).toContain("Discard suggestion");
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  test("an applied suggestion has nothing left to apply and waits for the save", () => {
    const html = renderToStaticMarkup(
      <ProposalCard author="PA" fields={fields} onApply={noop} onDiscard={noop} applied />,
    );
    expect(html).toContain("data-applied");
    expect(html).toContain("Filled the form. Nothing is saved until you save.");
    expect(html).not.toContain("Apply to form");
    expect(html).not.toContain("no longer describes the draft");
  });

  test("a suggestion that changes nothing has nothing to apply", () => {
    const html = renderToStaticMarkup(
      <ProposalCard
        author="PA"
        fields={[{ label: "Name", current: "same", proposed: "same" }]}
        onApply={noop}
      />,
    );
    expect(html).toMatch(/<button[^>]*disabled/);
  });
});
