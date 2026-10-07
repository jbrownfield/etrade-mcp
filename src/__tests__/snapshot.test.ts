import { describe, expect, it } from "bun:test";
import { buildSnapshot } from "../tools/snapshot.js";
import type { EtradeClient } from "../client.js";

function stubClient(overrides: Partial<EtradeClient> = {}): EtradeClient {
  return {
    listAccounts: async () => ({}),
    getQuote: async () => ({}),
    getBalance: async () => ({}),
    getPortfolio: async () => ({}),
    listTransactions: async () => ({}),
    getTransaction: async () => ({}),
    listOrders: async () => ({}),
    previewOrder: async () => ({}),
    placeOrder: async () => ({}),
    cancelOrder: async () => ({}),
    ...overrides,
  };
}

describe("buildSnapshot", () => {
  it("merges balance + positions across two accounts and sums totals", async () => {
    const client = stubClient({
      listAccounts: async () => ({
        AccountListResponse: {
          Accounts: {
            Account: [
              { accountIdKey: "k1", accountName: "A1", accountType: "MARGIN" },
              { accountIdKey: "k2", accountName: "A2", accountType: "CASH" },
            ],
          },
        },
      }),
      getBalance: async ({ accountIdKey }) => ({
        BalanceResponse: {
          Computed: {
            totalAvailableForWithdrawal: accountIdKey === "k1" ? 1000 : 500,
            cashBalance: accountIdKey === "k1" ? 1000 : 500,
            RealTimeValues: { totalAccountValue: accountIdKey === "k1" ? 5000 : 2000 },
          },
        },
      }),
      getPortfolio: async ({ accountIdKey }) => ({
        PortfolioResponse: {
          AccountPortfolio: [
            {
              Position: [
                {
                  positionId: 1,
                  symbolDescription: accountIdKey === "k1" ? "AAPL INC" : "MSFT INC",
                  Product: { symbol: accountIdKey === "k1" ? "AAPL" : "MSFT" },
                  quantity: 10,
                  pricePaid: 100,
                  marketValue: accountIdKey === "k1" ? 4000 : 1500,
                  totalGain: 100,
                  totalGainPct: 2.5,
                  daysGain: 5,
                },
              ],
            },
          ],
        },
      }),
    });

    const snap = await buildSnapshot(client, "sandbox", {});

    expect(snap.env).toBe("sandbox");
    expect(snap.accounts).toHaveLength(2);
    expect(snap.totals.netAccountValue).toBe(7000);
    expect(snap.totals.cashBalance).toBe(1500);
    expect(snap.totals.positionsValue).toBe(5500);
    expect(snap.accounts[0].positions[0].symbol).toBe("AAPL");
    expect(snap.accounts[1].positions[0].symbol).toBe("MSFT");
  });

  it("captures per-account errors instead of throwing", async () => {
    const client = stubClient({
      listAccounts: async () => ({
        AccountListResponse: {
          Accounts: { Account: [{ accountIdKey: "k1", accountName: "A1", accountType: "MARGIN" }] },
        },
      }),
      getBalance: async () => { throw new Error("balance boom"); },
      getPortfolio: async () => { throw new Error("portfolio boom"); },
    });

    const snap = await buildSnapshot(client, "sandbox", {});
    expect(snap.accounts[0].errors).toEqual([
      { op: "balance", error: "balance boom" },
      { op: "portfolio", error: "portfolio boom" },
    ]);
    expect(snap.accounts[0].positions).toEqual([]);
    expect(snap.totals.netAccountValue).toBe(0);
  });

  it("includes recent transactions when requested", async () => {
    const client = stubClient({
      listAccounts: async () => ({
        AccountListResponse: {
          Accounts: { Account: [{ accountIdKey: "k1", accountName: "A1", accountType: "MARGIN" }] },
        },
      }),
      listTransactions: async () => ({
        TransactionListResponse: { Transaction: [{ transactionId: 1, description: "BOUGHT AAPL" }] },
      }),
    });

    const snap = await buildSnapshot(client, "sandbox", { includeTransactions: true, recentDays: 7 });
    expect(snap.recentTransactions).toHaveLength(1);
  });
});

// Catch first-page-only aggregation, swallowed failures, and UTC date windows.
describe("snapshot completeness", () => {
  const listing = { AccountListResponse: { Accounts: { Account: [{ accountIdKey: "ira" }] } } };
  it("collects transaction pages and preserves their account key", async () => {
    const markers: (string | undefined)[] = [];
    const client = stubClient({ listAccounts: async () => listing, listTransactions: async ({ marker }) => {
      markers.push(marker);
      return { TransactionListResponse: marker ? { Transaction: [{ transactionId: 2 }], moreTransactions: false } : { Transaction: [{ transactionId: 1 }], marker: "next-marker", moreTransactions: true } };
    } });
    const snap = await buildSnapshot(client, "sandbox", { includeTransactions: true });
    expect(snap.recentTransactions).toEqual([{ transactionId: 1, accountIdKey: "ira" }, { transactionId: 2, accountIdKey: "ira" }]);
    expect(markers).toEqual([undefined, "next-marker"]);
  });
  it("reports failed transaction reads as incomplete", async () => {
    const snap = await buildSnapshot(stubClient({ listAccounts: async () => listing, listTransactions: async () => { throw new Error("transactions unavailable"); } }), "sandbox", { includeTransactions: true });
    expect(snap.complete).toBe(false);
    expect(snap.accounts[0].errors).toContainEqual({ op: "transactions", error: "transactions unavailable" });
  });
  it("stops repeated markers and reports incompleteness", async () => {
    let calls = 0;
    const snap = await buildSnapshot(stubClient({ listAccounts: async () => listing, listTransactions: async () => {
      if (++calls > 3) throw new Error("test loop guard");
      return { TransactionListResponse: { Transaction: [{ transactionId: 1 }], marker: "same", moreTransactions: true } };
    } }), "sandbox", { includeTransactions: true });
    expect(calls).toBe(2);
    expect(snap.complete).toBe(false);
    expect(snap.accounts[0].errors?.some(e => e.op === "transactions")).toBe(true);
  });
  it("reports a missing continuation marker", async () => {
    const snap = await buildSnapshot(stubClient({ listAccounts: async () => listing, listTransactions: async () => ({ TransactionListResponse: { Transaction: [], moreTransactions: true } }) }), "sandbox", { includeTransactions: true });
    expect(snap.complete).toBe(false);
  });
  it("aggregates portfolio pages", async () => {
    const snap = await buildSnapshot(stubClient({ listAccounts: async () => listing, getPortfolio: async ({ pageNumber }) => ({ PortfolioResponse: { AccountPortfolio: [{ Position: [{ positionId: pageNumber, Product: { symbol: pageNumber === 2 ? "MSFT" : "AAPL" }, quantity: 1, pricePaid: 100, marketValue: 100, totalGain: 0, totalGainPct: 0, daysGain: 0 }], ...(pageNumber === 2 ? {} : { nextPageNo: "2", totalNoOfPages: 2 }) }] } }) }), "sandbox", {});
    expect(snap.accounts[0].positions.map(p => p.symbol)).toEqual(["AAPL", "MSFT"]);
    expect(snap.totals.positionsValue).toBe(200);
  });
  it("uses Eastern calendar dates across the spring DST change", async () => {
    let dates: unknown;
    await buildSnapshot(stubClient({ listAccounts: async () => listing, listTransactions: async ({ startDate, endDate }) => { dates = { startDate, endDate }; return { TransactionListResponse: { Transaction: [] } }; } }), "sandbox", { includeTransactions: true, recentDays: 1 }, new Date("2026-03-09T04:30:00Z"));
    expect(dates).toEqual({ startDate: "03082026", endDate: "03092026" });
  });
});

describe("snapshot malformed data", () => {
  const listing = { AccountListResponse: { Accounts: { Account: [{ accountIdKey: "ira" }] } } };
  it("does not turn a malformed account list into a successful empty snapshot", async () => {
    await expect(buildSnapshot(stubClient(), "sandbox", {})).rejects.toThrow(/account/i);
  });
  for (const op of ["balance", "portfolio", "transactions"] as const) it(`marks missing ${op} data incomplete`, async () => {
    const snap = await buildSnapshot(stubClient({ listAccounts: async () => listing }), "sandbox", { includeTransactions: true });
    expect(snap.complete).toBe(false);
    expect(snap.accounts[0].errors?.some(e => e.op === op)).toBe(true);
  });
  it("does not mark a full portfolio page without a continuation as complete", async () => {
    const snap = await buildSnapshot(stubClient({ listAccounts: async () => listing, getPortfolio: async () => ({ PortfolioResponse: { AccountPortfolio: [{ Position: Array.from({ length: 50 }, () => ({ Product: { symbol: "ABC" } })) }] } }) }), "sandbox", {});
    expect(snap.accounts[0].errors?.some(e => e.op === "portfolio")).toBe(true);
  });
});

it("bounds transaction pagination and marks the result incomplete", async () => {
  let pages = 0;
  const snap = await buildSnapshot(stubClient({
    listAccounts: async () => ({ AccountListResponse: { Accounts: { Account: [{ accountIdKey: "ira" }] } } }),
    listTransactions: async () => ({ TransactionListResponse: { Transaction: [], marker: String(++pages), moreTransactions: true } }),
  }), "sandbox", { includeTransactions: true });
  expect(pages).toBe(1000);
  expect(snap.complete).toBe(false);
});
