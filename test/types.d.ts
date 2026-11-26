/// <reference types="vite/client" />

declare module "*.sql" {
	const sql: string;
	export default sql;
}

declare module "*.ejs" {
	const template: string;
	export default template;
}