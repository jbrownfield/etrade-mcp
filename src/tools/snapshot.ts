import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { EtradeClient } from "../client.js";

export type Snapshot = {
  env: "sandbox" | "prod";
  generatedAt: string;
  /** False if any requested account operation failed or pagination was incomplete. */
  complete: boolean;
  accounts: Array<{
    accountIdKey: string;
    accountName: string;
    accountType: string;
    balance: { totalAvailableForWithdrawal: number; cashBalance: number; netAccountValue: number };
    positions: Array<{
      symbol: string;
      quantity: number;
      pricePaid: number;
      marketValue: number;
      totalGain: number;
      totalGainPct: number;
      daysGain: number;
    }>;
    errors?: Array<{ op: "balance" | "portfolio" | "transactions"; error: string }>;
  }>;
  totals: { netAccountValue: number; cashBalance: number; positionsValue: number; totalGain: number };
  recentTransactions?: unknown[];
};

export type SnapshotArgs = { includeTransactions?: boolean; recentDays?: number };

const PAGE_SIZE = 50;

const positionSchema = z.object({
  positionId: z.union([z.string().min(1), z.number().int().safe()]),
  Product: z.object({ symbol: z.string().min(1) }),
  quantity: z.number().finite(),
  pricePaid: z.number().finite(),
  marketValue: z.number().finite(),
  totalGain: z.number().finite(),
  totalGainPct: z.number().finite(),
  daysGain: z.number().finite(),
});
const transactionSchema = z.object({
  transactionId: z.union([z.string().min(1), z.number().int().safe()]),
  amount: z.number().finite().optional(),
}).passthrough();

function pageNumberValue(value: unknown): number {
  if (!(typeof value === "number" || typeof value === "string" && /^\d+$/.test(value))) {
    throw new Error("Invalid portfolio pagination metadata.");
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid portfolio pagination metadata.");
  return number;
}

function continuationParameter(value: unknown, parameter: "marker" | "pageNumber"): string {
  try {
    if (typeof value !== "string") throw new Error();
    const parsed = new URL(value);
    const result = parsed.searchParams.get(parameter);
    if (!result) throw new Error();
    return result;
  } catch {
    // URL errors can echo the upstream input on some runtimes.
    throw new Error(`Invalid ${parameter === "marker" ? "transaction" : "portfolio"} continuation.`);
  }
}

export async function buildSnapshot(
  client: EtradeClient,
  env: "sandbox" | "prod",
  args: SnapshotArgs,
  now: Date = new Date(),
): Promise<Snapshot> {
  const accountsResp = (await client.listAccounts()) as {
    AccountListResponse?: { Accounts?: { Account?: Array<Record<string, unknown>> } };
  };
  const rawAccounts = accountsResp?.AccountListResponse?.Accounts?.Account;
  if (!Array.isArray(rawAccounts)) throw new Error("Invalid account list response.");

  const accounts = await Promise.all(
    rawAccounts.map(async (a) => {
      const accountIdKey = String(a.accountIdKey ?? "");
      const errors: Array<{ op: "balance" | "portfolio" | "transactions"; error: string }> = [];
      const balance = { totalAvailableForWithdrawal: 0, cashBalance: 0, netAccountValue: 0 };
      let positions: Snapshot["accounts"][number]["positions"] = [];

      try {
        const b = (await client.getBalance({ accountIdKey })) as {
          BalanceResponse?: {
            Computed?: {
              totalAvailableForWithdrawal?: number;
              cashBalance?: number;
              RealTimeValues?: { totalAccountValue?: number };
            };
          };
        };
        const computed = b?.BalanceResponse?.Computed;
        if (!computed || !Number.isFinite(computed.totalAvailableForWithdrawal) || !Number.isFinite(computed.cashBalance) || !Number.isFinite(computed.RealTimeValues?.totalAccountValue)) {
          throw new Error("Incomplete balance response.");
        }
        balance.totalAvailableForWithdrawal = b.BalanceResponse?.Computed?.totalAvailableForWithdrawal ?? 0;
        balance.cashBalance = b.BalanceResponse?.Computed?.cashBalance ?? 0;
        balance.netAccountValue = b.BalanceResponse?.Computed?.RealTimeValues?.totalAccountValue ?? 0;
      } catch (err) {
        errors.push({ op: "balance", error: (err as Error).message });
      }

      try {
        const rawPositions: Array<Record<string, unknown>> = [];
        let pageNumber = 1;
        const visited = new Set<number>();
        const positionIds = new Set<string>();
        let expectedPages: number | undefined;
        for (;;) {
          if (visited.has(pageNumber) || visited.size >= 1000) throw new Error("Portfolio pagination did not complete.");
          visited.add(pageNumber);
          const p = await client.getPortfolio({ accountIdKey, pageNumber, count: PAGE_SIZE }) as {
            PortfolioResponse?: { AccountPortfolio?: Array<{ Position?: Array<Record<string, unknown>>; nextPageNo?: string; totalNoOfPages?: number; totalPages?: number; next?: string }> };
          };
          const entries = p?.PortfolioResponse?.AccountPortfolio;
          if (!Array.isArray(entries)) throw new Error("Invalid portfolio response.");
          if (entries.length > 1) throw new Error("Unexpected extra account portfolio.");
          const page = entries[0];
          if (!page) {
            if (pageNumber !== 1) throw new Error("Missing portfolio continuation page.");
            break;
          }
          if (!Array.isArray(page.Position)) throw new Error("Invalid portfolio positions.");
          for (const value of page.Position) {
            const parsed = positionSchema.safeParse(value);
            if (!parsed.success) throw new Error("Incomplete or invalid portfolio position.");
            const id = String(parsed.data.positionId);
            if (positionIds.has(id)) throw new Error("Duplicate position across pages.");
            positionIds.add(id);
            rawPositions.push(parsed.data);
          }
          const rawTotal = page.totalNoOfPages ?? page.totalPages;
          const declaredTotal = rawTotal === undefined ? undefined : pageNumberValue(rawTotal);
          if (declaredTotal !== undefined) {
            if (expectedPages !== undefined && declaredTotal !== expectedPages) throw new Error("Portfolio page count changed during pagination.");
            expectedPages = declaredTotal;
          }
          const total = expectedPages;
          if (total !== undefined && (total < pageNumber && !(total === 0 && pageNumber === 1 && page.Position.length === 0))) {
            throw new Error("Contradictory portfolio page count.");
          }
          const rawNext = page.nextPageNo !== undefined && page.nextPageNo !== "" ? page.nextPageNo :
            page.next ? (/^\d+$/.test(page.next) ? page.next : continuationParameter(page.next, "pageNumber")) : undefined;
          const next = rawNext === undefined ? (total !== undefined && total > pageNumber ? pageNumber + 1 : undefined) : pageNumberValue(rawNext);
          if (next === undefined || next === 0) {
            if (total !== undefined && total > pageNumber) throw new Error("Missing portfolio continuation.");
            if (total === undefined && page.Position.length >= PAGE_SIZE) throw new Error("Missing portfolio continuation information.");
            break;
          }
          if (next !== pageNumber + 1 || total !== undefined && next > total) throw new Error("Invalid portfolio continuation.");
          pageNumber = next;
        }
        positions = rawPositions.map((pos) => ({
          symbol: String((pos.Product as Record<string, unknown> | undefined)?.symbol ?? ""),
          quantity: Number(pos.quantity ?? 0),
          pricePaid: Number(pos.pricePaid ?? 0),
          marketValue: Number(pos.marketValue ?? 0),
          totalGain: Number(pos.totalGain ?? 0),
          totalGainPct: Number(pos.totalGainPct ?? 0),
          daysGain: Number(pos.daysGain ?? 0),
        }));
      } catch (err) {
        errors.push({ op: "portfolio", error: (err as Error).message });
      }

      return {
        accountIdKey,
        accountName: String(a.accountName ?? ""),
        accountType: String(a.accountType ?? ""),
        balance,
        positions,
        ...(errors.length ? { errors } : {}),
      };
    }),
  );

  const totals = accounts.reduce(
    (acc, a) => ({
      netAccountValue: acc.netAccountValue + a.balance.netAccountValue,
      cashBalance: acc.cashBalance + a.balance.cashBalance,
      positionsValue: acc.positionsValue + a.positions.reduce((s, p) => s + p.marketValue, 0),
      totalGain: acc.totalGain + a.positions.reduce((s, p) => s + p.totalGain, 0),
    }),
    { netAccountValue: 0, cashBalance: 0, positionsValue: 0, totalGain: 0 },
  );

  let recentTransactions: unknown[] | undefined;
  if (args.includeTransactions) {
    const days = args.recentDays ?? 7;
    // Shift calendar dates in ET, rather than subtracting 24-hour instants across DST.
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (name: string) => Number(parts.find(p => p.type === name)!.value);
    const end = new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - days);
    const fmt = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}${d.getUTCFullYear()}`;
    recentTransactions = [];
    for (const a of accounts) {
      try {
        let marker: string | undefined;
        const visited = new Set<string>();
        const transactionIds = new Set<string>();
        let expectedTransactions: number | undefined;
        for (;;) {
          if (visited.size >= 1000) throw new Error("Transaction pagination did not complete.");
          const t = await client.listTransactions({ accountIdKey: a.accountIdKey, startDate: fmt(start), endDate: fmt(end), count: PAGE_SIZE, marker }) as {
            TransactionListResponse?: { Transaction?: Array<Record<string, unknown>>; marker?: string; next?: string; moreTransactions?: boolean | string; transactionCount?: number; totalCount?: number };
          };
          const page = t?.TransactionListResponse;
          if (!page || !Array.isArray(page.Transaction)) throw new Error("Invalid transaction response.");
          const transactions = page.Transaction;
          for (const count of [page.transactionCount, page.totalCount]) {
            if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw new Error("Invalid transaction count.");
          }
          if (page.totalCount !== undefined) {
            if (expectedTransactions !== undefined && expectedTransactions !== page.totalCount) throw new Error("Transaction total changed during pagination.");
            expectedTransactions = page.totalCount;
          }
          if (page.transactionCount !== undefined && page.transactionCount !== transactions.length) throw new Error("Transaction page count mismatch.");
          const parsedTransactions = transactions.map(tx => {
            const parsed = transactionSchema.safeParse(tx);
            if (!parsed.success) throw new Error("Invalid transaction record.");
            return parsed.data;
          });
          for (const tx of parsedTransactions) {
            const id = String(tx.transactionId);
            if (transactionIds.has(id)) throw new Error("Duplicate transaction across pages.");
            transactionIds.add(id);
            recentTransactions.push({ ...tx, accountIdKey: a.accountIdKey });
          }
          if (expectedTransactions !== undefined && transactionIds.size > expectedTransactions) throw new Error("Transaction total count mismatch.");
          const more = page.moreTransactions;
          if (more !== undefined && ![true, false, "true", "false"].includes(more)) throw new Error("Invalid transaction continuation flag.");
          // The broker's own example has next + moreTransactions=false: an explicit
          // continuation takes precedence over that flag. Never fetch the supplied URL.
          const linkMarker = page.next ? continuationParameter(page.next, "marker") : undefined;
          const remaining = expectedTransactions !== undefined && transactionIds.size < expectedTransactions;
          const stopped = more === false || more === "false";
          const next = linkMarker || (!stopped || remaining ? page.marker : undefined);
          if (!next) {
            if (remaining || more === true || more === "true" || !stopped && transactions.length >= PAGE_SIZE) throw new Error("Missing transaction continuation marker.");
            break;
          }
          if (typeof next !== "string") throw new Error("Invalid transaction continuation marker.");
          if (visited.has(next)) throw new Error("Transaction pagination did not complete.");
          visited.add(next);
          marker = next;
        }
      } catch (err) {
        (a.errors ??= []).push({ op: "transactions", error: (err as Error).message });
      }
    }
  }

  return {
    env,
    generatedAt: now.toISOString(),
    complete: accounts.every(a => !a.errors?.length),
    accounts,
    totals,
    ...(recentTransactions ? { recentTransactions } : {}),
  };
}

const argsSchema = {
  includeTransactions: z.boolean().optional().describe("Default false."),
  recentDays: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .describe("Default 7. Ignored unless includeTransactions=true."),
};

export function registerSnapshot(
  server: McpServer,
  env: "sandbox" | "prod",
  getClient: () => EtradeClient | Error,
) {
  server.tool(
    "etrade_snapshot",
    "Fan-out snapshot of all E*TRADE accounts: balances + positions (+ optional recent transactions).",
    argsSchema,
    async (args) => {
      const c = getClient();
      if (c instanceof Error) return { content: [{ type: "text" as const, text: c.message }], isError: true };
      try {
        const snap = await buildSnapshot(c, env, args);
        return { content: [{ type: "text" as const, text: JSON.stringify(snap, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `snapshot failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
