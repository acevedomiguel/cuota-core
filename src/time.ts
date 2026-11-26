// The household's clock. Cuota is a two-person app where "today" is the Hong
// Kong calendar day (UTC+8), not the server's UTC day or each viewer's browser
// zone: the two of them share one household date. Every date the app derives —
// the default expense date, the current month's stats, an opening event's
// date, the analytics year — comes from here, so one definition keeps them
// from drifting apart.

/** ISO date (`YYYY-MM-DD`) for "today" as the household sees it. */
export function todayInHongKong(): string {
	return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** The household's current calendar year. */
export function hongKongYear(): number {
	return Number(todayInHongKong().slice(0, 4));
}
