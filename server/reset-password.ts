import { hashPassword, normalizeEmail, passwordLongEnough } from "../src/auth.js";
import { openDatabase } from "./database.js";
import { loadSettings } from "./env.js";

/**
 * Owner recovery CLI: `npm run reset-password -- <email>`.
 *
 * The password comes from stdin and never from an argument, so it cannot land
 * in shell history or a process list. With a terminal it is read without echo;
 * a pipe works too (`printf 'new-password' | npm run reset-password -- …`).
 */

const MIN_PASSWORD_LENGTH = 12;

function readPiped(): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
		process.stdin.on("end", () =>
			// A pipe or heredoc ends with a newline that is not part of the
			// password; a terminal path never adds one.
			resolve(Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "")),
		);
	});
}

function readHidden(prompt: string): Promise<string> {
	return new Promise((resolve, reject) => {
		let value = "";
		const stdin = process.stdin;

		if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
			process.stderr.write(prompt);
			void readPiped().then(resolve, reject);
			return;
		}

		process.stderr.write(prompt);
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");

		const onData = (chunk: string) => {
			for (const char of chunk) {
				switch (char) {
					case "\u0003": // Ctrl-C
						stdin.setRawMode(false);
						stdin.pause();
						process.stderr.write("\n");
						process.exit(130);
						break;
					case "\r":
					case "\n":
						stdin.setRawMode(false);
						stdin.pause();
						stdin.off("data", onData);
						process.stderr.write("\n");
						resolve(value);
						return;
					case "\u007f":
					case "\b":
						if (value.length > 0) {
							value = value.slice(0, -1);
							process.stderr.write("\b \b");
						}
						break;
					default:
						if (char >= " ") {
							value += char;
							process.stderr.write("*");
						}
				}
			}
		};

		stdin.on("data", onData);
	});
}

async function main(): Promise<number> {
	const email = normalizeEmail(process.argv[2] ?? "");
	if (!email) {
		process.stderr.write("Usage: npm run reset-password -- <email>\n");
		return 1;
	}

	const settings = loadSettings();
	const opened = await openDatabase(settings.databaseUrl);

	try {
		const user = await opened.db
			.prepare("SELECT id FROM users WHERE email = ?")
			.bind(email)
			.first<{ id: number }>();

		if (!user) {
			process.stderr.write(`No account for ${email}. Nothing changed.\n`);
			return 1;
		}

		const password = await readHidden(`New password for ${email}: `);
		if (!password) {
			process.stderr.write("No password on stdin. Nothing changed.\n");
			return 1;
		}
		if (!passwordLongEnough(password)) {
			process.stderr.write(`Password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing changed.\n`);
			return 1;
		}

		await opened.db
			.prepare("UPDATE users SET password_hash = ? WHERE id = ?")
			.bind(await hashPassword(password), user.id)
			.run();

		process.stderr.write(`Password updated for ${email}.\n`);
		return 0;
	} finally {
		await opened.close();
	}
}

process.exitCode = await main();