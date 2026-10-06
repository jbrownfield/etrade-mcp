import { describe, expect, it } from "bun:test";
import type { EtradeClient } from "../client.js";
import { buildSnapshot } from "../tools/snapshot.js";
const balance = { BalanceResponse: { Computed: { totalAvailableForWithdrawal: 10, cashBalance: 10, RealTimeValues: { totalAccountValue: 110 } } } };
const position = { positionId: 1, Product: { symbol: "ABC" }, quantity: 1, pricePaid: 50, marketValue: 100, totalGain: 50, totalGainPct: 100, daysGain: 0 };
function client(overrides: Partial<EtradeClient> = {}): EtradeClient {
  return { listAccounts: async () => ({ AccountListResponse: { Accounts: { Account: [{ accountIdKey: "ira" }] } } }), getBalance: async () => balance,
    getPortfolio: async () => ({ PortfolioResponse: { AccountPortfolio: [{ Position: [position] }] } }),
    listTransactions: async () => ({ TransactionListResponse: { Transaction: [] } }),
    getQuote: async () => ({}), getTransaction: async () => ({}), listOrders: async () => ({}), previewOrder: async () => ({}), placeOrder: async () => ({}), cancelOrder: async () => ({}), ...overrides };
}
describe("adversarial snapshot completeness", () => {
  for (const page of [{}, { Position: [{}] }, { Position: [{ ...position, marketValue: "garbage" }] }, { Position: [{ ...position, quantity: null }] }]) {
    it(`rejects malformed portfolio content ${JSON.stringify(page)}`, async () => {
      const snap = await buildSnapshot(client({ getPortfolio: async () => ({ PortfolioResponse: { AccountPortfolio: [page] } }) }), "sandbox", {});
      expect(snap.complete).toBe(false);
      expect(snap.accounts[0].errors?.some(e => e.op === "portfolio")).toBe(true);
    });
  }
  for (const page of [{}, { Transaction: [null] }, { Transaction: ["bad"] }, { Transaction: [{}] }]) {
    it(`rejects malformed transaction content ${JSON.stringify(page)}`, async () => {
      const snap = await buildSnapshot(client({ listTransactions: async () => ({ TransactionListResponse: page }) }), "sandbox", { includeTransactions: true });
      expect(snap.complete).toBe(false);
      expect(snap.accounts[0].errors?.some(e => e.op === "transactions")).toBe(true);
      expect(snap.recentTransactions).toEqual([]);
    });
  }
  it("follows an explicit next link despite a false moreTransactions flag", async () => {
    const markers: (string | undefined)[] = [];
    const snap = await buildSnapshot(client({ listTransactions: async ({ marker }) => {
      markers.push(marker);
      return { TransactionListResponse: marker ? { Transaction: [{ transactionId: 2 }], moreTransactions: false, transactionCount: 1, totalCount: 2 } : {
        Transaction: [{ transactionId: 1 }], moreTransactions: false, next: "https://api.etrade.com/v1/accounts/ira/transactions?marker=next", transactionCount: 1, totalCount: 2 } };
    } }), "sandbox", { includeTransactions: true });
    expect(snap.complete).toBe(true);
    expect(markers).toEqual([undefined, "next"]);
    expect(snap.recentTransactions).toHaveLength(2);
  });
  it("does not call a truncated transaction result complete when totalCount disagrees", async () => {
    const snap = await buildSnapshot(client({ listTransactions: async () => ({ TransactionListResponse: { Transaction: [{ transactionId: 1 }], moreTransactions: false, totalCount: 2 } }) }), "sandbox", { includeTransactions: true });
    expect(snap.complete).toBe(false);
  });
  it("rejects a zero portfolio continuation when the declared total says pages remain", async () => {
    const snap = await buildSnapshot(client({ getPortfolio: async () => ({ PortfolioResponse: { AccountPortfolio: [{ Position: [position], nextPageNo: "0", totalNoOfPages: 2 }] } }) }), "sandbox", {});
    expect(snap.complete).toBe(false);
  });
  it("rejects a portfolio continuation that skips a page", async () => {
    const snap = await buildSnapshot(client({ getPortfolio: async ({ pageNumber }) => ({ PortfolioResponse: { AccountPortfolio: [{ Position: [position], nextPageNo: pageNumber === 1 ? "3" : "0", totalNoOfPages: 3 }] } }) }), "sandbox", {});
    expect(snap.complete).toBe(false);
  });
  it("detects duplicate transaction rows instead of silently counting them twice", async () => {
    const snap = await buildSnapshot(client({ listTransactions: async ({ marker }) => ({ TransactionListResponse: { Transaction: [{ transactionId: 1 }], ...(marker ? { moreTransactions: false } : { marker: "next", moreTransactions: true }) } }) }), "sandbox", { includeTransactions: true });
    expect(snap.complete).toBe(false);
    expect(snap.recentTransactions).toHaveLength(1);
  });
  it("supports numeric portfolio continuations without mistaking them for URLs", async () => {
    const snap = await buildSnapshot(client({ getPortfolio: async ({ pageNumber }) => ({ PortfolioResponse: { AccountPortfolio: [{ Position: [{ ...position, positionId: pageNumber }], ...(pageNumber === 1 ? { next: "2", totalNoOfPages: 2 } : { totalNoOfPages: 2 }) }] } }) }), "sandbox", {});
    expect(snap.complete).toBe(true);
    expect(snap.accounts[0].positions).toHaveLength(2);
  });
});

it("rejects duplicate position IDs across portfolio pages", async () => {
  const snap = await buildSnapshot(client({ getPortfolio: async ({ pageNumber }) => ({ PortfolioResponse: { AccountPortfolio: [{ Position: [position], totalNoOfPages: 2, ...(pageNumber === 1 ? { nextPageNo: "2" } : {}) }] } }) }), "sandbox", {});
  expect(snap.complete).toBe(false);
  expect(snap.accounts[0].errors?.some(e => e.op === "portfolio")).toBe(true);
});
it("remembers a portfolio total when later pages omit it", async () => {
  const snap = await buildSnapshot(client({ getPortfolio: async ({ pageNumber }) => ({ PortfolioResponse: { AccountPortfolio: [{ Position: [{ ...position, positionId: pageNumber }], ...(pageNumber === 1 ? { totalNoOfPages: 3, nextPageNo: "2" } : {}) }] } }) }), "sandbox", {});
  expect(snap.complete).toBe(true);
  expect(snap.accounts[0].positions).toHaveLength(3);
});
it("remembers the expected transaction total across later pages", async () => {
  const snap = await buildSnapshot(client({ listTransactions: async ({ marker }) => ({ TransactionListResponse: marker ? { Transaction: [{ transactionId: 2 }], moreTransactions: false } : { Transaction: [{ transactionId: 1 }], totalCount: 3, marker: "next", moreTransactions: true } }) }), "sandbox", { includeTransactions: true });
  expect(snap.complete).toBe(false);
});
it("does not expose an upstream continuation string in errors", async () => {
  const snap = await buildSnapshot(client({ listTransactions: async () => ({ TransactionListResponse: { Transaction: [], next: "PRIVATE-CONTINUATION-TEXT" } }) }), "sandbox", { includeTransactions: true });
  expect(snap.complete).toBe(false);
  expect(snap.accounts[0].errors?.[0].error).toBe("Invalid transaction continuation.");
});
it("honors totalPages when the last portfolio page has exactly the requested count", async () => {
  const snap = await buildSnapshot(client({ getPortfolio: async ({ pageNumber }) => ({ PortfolioResponse: { AccountPortfolio: [{ Position: Array.from({ length: 50 }, (_, index) => ({ ...position, positionId: (pageNumber! - 1) * 50 + index })), totalPages: 2, ...(pageNumber === 1 ? { next: "2" } : {}) }] } }) }), "sandbox", {});
  expect(snap.complete).toBe(true);
  expect(snap.accounts[0].positions).toHaveLength(100);
});

import { readFileSync } from "node:fs";
it("flags the hand-crafted fixture's contradictory continuation instead of calling it complete", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/portfolio.json", import.meta.url), "utf8"));
  const snap = await buildSnapshot(client({ getPortfolio: async () => fixture }), "sandbox", {});
  expect(snap.complete).toBe(false);
  expect(snap.accounts[0].errors).toContainEqual({ op: "portfolio", error: "Invalid portfolio continuation." });
});
it("rejects a zero page total when positions are present", async () => {
  const snap = await buildSnapshot(client({ getPortfolio: async () => ({ PortfolioResponse: { AccountPortfolio: [{ Position: [position], totalNoOfPages: 0 }] } }) }), "sandbox", {});
  expect(snap.complete).toBe(false);
});
it("rejects a full portfolio page whose continuation is missing", async () => {
  const snap = await buildSnapshot(client({ getPortfolio: async () => ({ PortfolioResponse: { AccountPortfolio: [{ Position: Array.from({ length: 50 }, (_, positionId) => ({ ...position, positionId })) }] } }) }), "sandbox", {});
  expect(snap.accounts[0].errors).toContainEqual({ op: "portfolio", error: "Missing portfolio continuation information." });
});
it("uses Eastern calendar dates across the autumn transition", async () => {
  let dates: unknown;
  await buildSnapshot(client({ listTransactions: async ({ startDate, endDate }) => { dates = { startDate, endDate }; return { TransactionListResponse: { Transaction: [] } }; } }), "sandbox", { includeTransactions: true, recentDays: 1 }, new Date("2026-11-02T04:30:00Z"));
  expect(dates).toEqual({ startDate: "10312026", endDate: "11012026" });
});
