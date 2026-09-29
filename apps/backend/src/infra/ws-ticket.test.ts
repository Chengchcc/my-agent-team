import { describe, expect, test } from "bun:test";
import { createWsTicketRegistry } from "./ws-ticket.js";

describe("ws ticket registry", () => {
  test("a minted ticket is accepted once", () => {
    const tickets = createWsTicketRegistry();
    const ticket = tickets.mint();
    expect(ticket).toHaveLength(64);
    expect(tickets.consume(ticket)).toBe(true);
    expect(tickets.consume(ticket)).toBe(false);
  });

  test("an unknown ticket is refused", () => {
    expect(createWsTicketRegistry().consume("nope")).toBe(false);
  });

  test("a ticket expires", () => {
    let now = 1_000;
    const tickets = createWsTicketRegistry({ ttlMs: 50, now: () => now });
    const ticket = tickets.mint();
    now += 51;
    expect(tickets.consume(ticket)).toBe(false);
  });

  test("minting prunes expired tickets", () => {
    let now = 1_000;
    const tickets = createWsTicketRegistry({ ttlMs: 50, now: () => now });
    const first = tickets.mint();
    now += 51;
    const second = tickets.mint();
    expect(tickets.consume(first)).toBe(false);
    expect(tickets.consume(second)).toBe(true);
  });
});
