/**
 * gh guard
 *
 * Guard for the GitHub CLI (`gh`) when run through the bash tool.
 *  - Write commands (create/edit/delete/merge/close/comment/..., `gh api` with a non-GET
 *    method or body fields, GraphQL mutations) are BLOCKED outright.
 *  - Everything else is assumed read-only but still PROMPTS the user (blocked when there is
 *    no UI to ask).
 *
 * This is a guardrail, not a security boundary: it cannot see through variables, eval,
 * wrapper scripts, `curl` with the token, etc. The read-only fine-grained PAT is the hard limit.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Verbs that change data. Matched against the 2nd and 3rd leading positional words
 * (e.g. `gh pr merge`, `gh repo deploy-key add`, `gh workflow run`).
 */
const WRITE_VERBS = new Set([
	"create", "new", "edit", "update", "update-branch", "delete", "remove", "rm", "add",
	"set", "unset", "rename", "transfer", "archive", "unarchive", "fork", "sync", "import",
	"merge", "close", "reopen", "comment", "review", "ready", "revert", "lock", "unlock",
	"pin", "unpin", "develop", "rerun", "cancel", "enable", "disable", "run", "upload",
	"delete-asset", "clone-label", "copy", "link", "unlink", "mark-template",
	"item-add", "item-create", "item-edit", "item-delete", "item-archive",
	"field-create", "field-delete", "stop", "rebuild", "install", "upgrade", "exec",
	"login", "logout", "refresh", "switch", "setup-git", "token", "clear-cache", "dispatch",
]);

/** Top-level commands that are blocked regardless of verb. */
const WRITE_TOP_LEVEL = new Set([
	"alias", "extension", "ext", "attestation-write",
	// Forbidden by the gh skill (credentials, secrets, config, local state, browser):
	"secret", "variable", "ssh-key", "gpg-key", "codespace", "config", "browse",
]);

/** Flags (before the subcommand) that take a value, so the value is not mistaken for a subcommand. */
const VALUE_FLAGS = ["-R", "--repo", "--hostname"];

/** Nested command groups whose verb sits one level deeper (deploy-key etc.). */
const NESTED_GROUPS = new Set(["deploy-key", "gpg-key", "ssh-key"]);

/** Flags that print the token or open a browser. */
const isForbiddenFlag = (a: string) =>
	a === "--show-token" || a === "--web" || a === "-w" || a.startsWith("--web=") || a.startsWith("--show-token=");

const HELP_FLAGS = new Set(["-h", "--help", "--version"]);
const BODY_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

interface Token {
	text: string;
	quoted: boolean;
}

/** Minimal shell tokenizer: splits into command segments, keeps quoted strings as one token. */
function tokenize(input: string): Token[][] {
	const segments: Token[][] = [];
	let tokens: Token[] = [];
	let cur = "";
	let has = false;
	let quoted = false;

	const pushToken = () => {
		if (has) tokens.push({ text: cur, quoted });
		cur = "";
		has = false;
		quoted = false;
	};
	const pushSegment = () => {
		pushToken();
		if (tokens.length) segments.push(tokens);
		tokens = [];
	};

	for (let i = 0; i < input.length; i++) {
		const c = input[i];
		if (c === "'") {
			quoted = has = true;
			const end = input.indexOf("'", i + 1);
			const stop = end === -1 ? input.length : end;
			cur += input.slice(i + 1, stop);
			i = stop;
		} else if (c === '"') {
			quoted = has = true;
			i++;
			while (i < input.length && input[i] !== '"') {
				if (input[i] === "\\" && i + 1 < input.length) i++;
				cur += input[i++];
			}
		} else if (c === "\\" && i + 1 < input.length) {
			has = true;
			cur += input[++i];
		} else if (c === " " || c === "\t") {
			pushToken();
		} else if (";&|\n()`".includes(c)) {
			pushSegment();
		} else {
			has = true;
			cur += c;
		}
	}
	pushSegment();
	return segments;
}

const isGh = (t: string) => t === "gh" || t.endsWith("/gh") || t === "gh.exe";

export interface Finding {
	display: string;
	/** Present when the command is a write and must be blocked. */
	blockReason?: string;
}

/** Returns the reason a `gh api` call is a write, or undefined if it looks like a GET. */
function apiWriteReason(args: string[]): string | undefined {
	let explicitMethod: string | undefined;
	let hasBody = false;
	let graphql = false;

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-X" || a === "--method") {
			explicitMethod = args[++i]?.toUpperCase();
		} else if (a.startsWith("--method=")) {
			explicitMethod = a.slice("--method=".length).toUpperCase();
		} else if (/^-X./.test(a)) {
			explicitMethod = a.slice(2).toUpperCase();
		} else if (BODY_FLAGS.has(a) || /^(-f|-F)./.test(a) || a.startsWith("--field=") || a.startsWith("--raw-field=") || a.startsWith("--input=")) {
			hasBody = true;
		} else if (a === "graphql") {
			graphql = true;
		}
	}

	if (explicitMethod && explicitMethod !== "GET" && explicitMethod !== "HEAD") {
		return `gh api with method ${explicitMethod}`;
	}
	if (graphql && args.some((a) => /\bmutation\b/i.test(a))) return "GraphQL mutation";
	if (graphql && args.some((a) => a === "--input" || a.startsWith("--input=") || /=@/.test(a))) {
		return "GraphQL query read from a file cannot be inspected for mutations";
	}
	if (!explicitMethod && hasBody && !graphql) return "gh api with body fields (implies POST)";
	return undefined;
}

/** Returns every `gh` invocation found in `command`, flagged as blocked or prompt-only. */
export function findInvocations(command: string, depth = 0): Finding[] {
	const found: Finding[] = [];
	if (depth > 5) return [{ display: command, blockReason: "too deeply nested to analyse" }];

	for (const seg of tokenize(command)) {
		for (let i = 0; i < seg.length; i++) {
			const tok = seg[i];

			// Quoted strings that look like a gh command (e.g. `sh -c "gh pr merge 1"`) are analysed.
			if ((tok.quoted || /\s/.test(tok.text)) && !isGh(tok.text) && /\bgh\b/.test(tok.text)) {
				found.push(...findInvocations(tok.text, depth + 1));
				continue;
			}
			// Shell quotes do not change the executable: "gh" and 'gh' still invoke gh.
			if (!isGh(tok.text)) continue;

			const args = seg.slice(i + 1).map((t) => t.text);
			const display = ["gh", ...args].join(" ");
			if (args.some((a) => HELP_FLAGS.has(a))) continue;

			// Leading positionals, skipping known flags that precede the subcommand (`gh -R o/r pr merge`).
			const positionals: string[] = [];
			for (let j = 0; j < args.length; j++) {
				const a = args[j];
				if (!a.startsWith("-")) {
					positionals.push(a);
				} else if (VALUE_FLAGS.includes(a)) {
					j++;
				} else if (VALUE_FLAGS.some((f) => (f.startsWith("--") ? a.startsWith(f + "=") : a.startsWith(f)))) {
					continue;
				} else {
					break;
				}
			}
			if (positionals.length === 0 && args.every((a) => a.startsWith("-"))) continue; // bare gh

			const [top, ...rest] = positionals;
			let blockReason: string | undefined;

			const forbidden = args.find(isForbiddenFlag);
			if (forbidden) {
				blockReason = `${forbidden} is not allowed`;
			} else if (WRITE_TOP_LEVEL.has(top)) {
				blockReason = `gh ${top} is not allowed`;
			} else if (top === "api") {
				blockReason = apiWriteReason(args);
			} else if (top === "search") {
				// Search terms are free text, so no verb check; but it must be scoped.
				const scoped = args.some((a) => /^--(owner|repo)(=|$)/.test(a));
				if (!scoped) blockReason = "gh search must be scoped with --owner or --repo";
			} else {
				const candidates = NESTED_GROUPS.has(rest[0]) ? rest.slice(0, 2) : rest.slice(0, 1);
				const verb = candidates.find((w) => WRITE_VERBS.has(w));
				if (verb) blockReason = `gh ${top} ${verb} changes data`;
			}

			found.push({ display, blockReason });
		}
	}
	return found;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = String(event.input.command ?? "");
		if (!/\bgh\b/.test(command)) return undefined;

		const findings = findInvocations(command);
		if (findings.length === 0) return undefined;

		const blocked = findings.filter((f) => f.blockReason);
		if (blocked.length > 0) {
			const list = blocked.map((f) => `  ${f.display}  (${f.blockReason})`).join("\n");
			return { block: true, reason: `Blocked gh write command(s):\n${list}` };
		}

		const list = findings.map((f) => `  ${f.display}`).join("\n");
		if (!ctx.hasUI) {
			return { block: true, reason: `gh command needs confirmation (no UI to ask):\n${list}` };
		}

		const choice = await ctx.ui.select(`gh command:\n\n${list}\n\nAllow?`, ["Yes", "No"]);
		if (choice !== "Yes") return { block: true, reason: "Blocked by user: gh command" };
		return undefined;
	});
}
