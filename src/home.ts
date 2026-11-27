// The home dashboard's data: who owes whom (from the snapshot-cached
// balance), the income ratio, this month's stats, and the recent ledger with
// per-person shares. Kept out of the app factory so the shape can be tested.

import { currentBalance } from "./balance.js";
import { formatHKD, sharesForExpense } from "./calc.js";
import { listUsers } from "./db.js";
import { latestSnapshot, listExpenses, listIncomes, openingEvent } from "./ledger.js";
import type { SqlDatabase } from "./ports.js";
import { currentRatio, listSharingRules, sharingResolver } from "./sharing.js";
import { todayInHongKong } from "./time.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface ExpenseView {
	description: string;
	/** `llama` for the first user, `mono` for the second. */
	tone: "llama" | "mono";
	when: string;
	/** Who fronted it this time. */
	payer: string;
	paid: string;
	shareLabel: string;
	share: string;
}

export interface HomeView {
	balanceLabel: string;
	balanceAmount: string;
	even: boolean;
	snapshotNote: string | null;
	openingNote: string | null;
	/** True until an opening balance exists, so the card only nags once. */
	openingSetup: boolean;
	setup: boolean;
	empty: boolean;
	pct: [number, number];
	names: [string, string];
	stats: { spent: string; mine: string };
	expenses: ExpenseView[];
}

/** `2026-11-20` shifted by `days`, as an ISO date. */
function shiftDay(iso: string, days: number): string {
	const date = new Date(`${iso}T00:00:00.000Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

/** `2026-11-20` → `Nov 20`; today/yesterday become words. */
function whenLabel(date: string, today: string): string {
	if (today) {
		if (date === today) return "Today";
		if (date === shiftDay(today, -1)) return "Yesterday";
	}
	const [, month, day] = date.split("-");
	return `${MONTHS[Number(month) - 1]} ${Number(day)}`;
}

/** `2026-11-20T00:00:00.000Z` → `Nov 20`. */
function shortDate(iso: string): string {
	const [, month, day] = iso.slice(0, 10).split("-");
	return `${MONTHS[Number(month) - 1]} ${Number(day)}`;
}

export async function buildHome(db: SqlDatabase, viewerId: number): Promise<HomeView> {
	const users = await listUsers(db);
	const [first, second] = users;
	const [incomes, allExpenses, snapshot, balance, opening, rules] = await Promise.all([
		listIncomes(db),
		listExpenses(db, 5000),
		latestSnapshot(db),
		first && second ? currentBalance(db, first.id, second.id) : Promise.resolve(0),
		openingEvent(db),
		listSharingRules(db),
	]);

	const salaryNow = (id: number | undefined) =>
		id === undefined ? 0 : (incomes.filter((i) => i.user_id === id).at(-1)?.amount_cents ?? 0);

	const firstId = first?.id ?? 0;
	const secondId = second?.id ?? 0;
	const lowerId = firstId < secondId;
	// The split in force now, from the sharing rule or the salaries.
	const resolveSplit = sharingResolver(incomes, rules, firstId, secondId);
	const splitAt = (asOf: string) => {
		const a = resolveSplit(firstId, asOf);
		const b = resolveSplit(secondId, asOf);
		const total = a + b;
		return total <= 0 ? { a: 0.5, b: 0.5 } : { a: a / total, b: b / total };
	};
	const ratio = currentRatio(incomes, rules, firstId, secondId);
	const pctA = Math.round(ratio.a * 100);

	const tone = (id: number) => (id === secondId ? "mono" : "llama");
	const nameOf = (id: number) => users.find((u) => u.id === id)?.name ?? "Someone";

	const today = todayInHongKong();
	const monthPrefix = today.slice(0, 7);

	// This month's spend and the viewer's share of it, at each expense's
	// frozen ratio.
	let spent = 0;
	let mine = 0;
	for (const e of allExpenses) {
		if (!e.date.startsWith(monthPrefix)) continue;
		spent += e.amount_cents;
		const at = splitAt(e.created_at);
		const shares = sharesForExpense(e.amount_cents, at.a, lowerId);
		mine += viewerId === firstId ? shares.a : shares.b;
	}

	const owes = balance > 0;
	const ower = owes ? secondId : firstId;
	const owedTo = owes ? firstId : secondId;
	const even = Math.abs(balance) <= 1;

	const recent = allExpenses.slice(0, 10).map<ExpenseView>((e) => {
		const at = splitAt(e.created_at);
		const shares = sharesForExpense(e.amount_cents, at.a, lowerId);
		const viewerIsPayer = e.payer_id === viewerId;
		const viewerShare = viewerId === firstId ? shares.a : shares.b;
		const otherShare = viewerId === firstId ? shares.b : shares.a;
		return {
			description: e.description,
			tone: tone(e.payer_id),
			when: whenLabel(e.date, today),
			payer: nameOf(e.payer_id),
			paid: formatHKD(e.amount_cents),
			shareLabel: viewerIsPayer ? "their share" : "your share",
			share: formatHKD(viewerIsPayer ? otherShare : viewerShare),
		};
	});

	return {
		balanceLabel: even
			? "You're even"
			: `${nameOf(ower)} owes ${nameOf(owedTo)}`,
		balanceAmount: formatHKD(Math.abs(balance)),
		even,
		snapshotNote: snapshot ? `Balance cached from ${shortDate(snapshot.cutoff)}` : null,
		openingNote: opening
			? `Includes HK$ ${formatHKD(opening.amount_cents).replace("HK$ ", "")} opening balance from ${nameOf(opening.from_user_id)}`
			: null,
		openingSetup: opening === null,
		// A fixed rule needs no salaries, so it is not "setup pending".
		setup: rules.at(-1)?.mode !== "fixed" && (salaryNow(firstId) === 0 || salaryNow(secondId) === 0),
		empty: allExpenses.length === 0,
		pct: [pctA, 100 - pctA],
		names: [first?.name ?? "You", second?.name ?? "Partner"],
		stats: { spent: formatHKD(spent), mine: formatHKD(mine) },
		expenses: recent,
	};
}
