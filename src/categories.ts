// The fixed set of expense categories used by the analytics breakdown. Kept as
// pure data so the add form, the validator, and the analytics page all agree on
// one list, and so a value stored by an older or direct write can still be
// labelled sensibly instead of disappearing.

export interface Category {
	id: string;
	label: string;
}

/** The values a user can pick in the add-expense form. */
export const CATEGORIES: Category[] = [
	{ id: "groceries", label: "Groceries" },
	{ id: "dining", label: "Dining out" },
	{ id: "transport", label: "Transport" },
	{ id: "housing", label: "Housing" },
	{ id: "utilities", label: "Utilities" },
	{ id: "health", label: "Health" },
	{ id: "entertainment", label: "Entertainment" },
	{ id: "shopping", label: "Shopping" },
	{ id: "travel", label: "Travel" },
	{ id: "other", label: "Other" },
];

/** The bucket every expense falls back to, including pre-category history. */
export const UNCATEGORIZED = "uncategorized";

/** Uncategorized first — the form default — then the pickable set. */
export const CATEGORY_OPTIONS: Category[] = [
	{ id: UNCATEGORIZED, label: "Uncategorized" },
	...CATEGORIES,
];

/** True for the default bucket or any pickable category id. */
export function isValidCategory(id: string): boolean {
	return id === UNCATEGORIZED || CATEGORIES.some((c) => c.id === id);
}

/** A display label for any stored value, including ones not in the list. */
export function categoryLabel(id: string): string {
	if (id === UNCATEGORIZED || id.length === 0) return "Uncategorized";
	const known = CATEGORIES.find((c) => c.id === id);
	if (known) return known.label;
	// An unrecognised value (e.g. a direct write): title-case it so it is still
	// readable and grouped, rather than silently vanishing from the breakdown.
	return id.charAt(0).toUpperCase() + id.slice(1);
}
