import { templates } from "./views-compiled.js";
import type { TemplateFn } from "./views-compiled.js";

function render(name: string, locals: Record<string, unknown>): string {
	const fn: TemplateFn | undefined = templates[name];
	if (!fn) throw new Error(`unknown template: ${name}`);
	const include = (partial: string, data?: Record<string, unknown>): string =>
		render(partial, { ...locals, ...data });
	return fn(locals, undefined, include, undefined);
}

export function renderView(name: string, locals: Record<string, unknown>): string {
	return render(name, locals);
}
