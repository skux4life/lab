/**
 * aws guard
 *
 * Guard for the AWS CLI (and scripts that use it) when run through the bash tool.
 *  - BLOCK (always, no prompt): IAM / Organizations / SSO-admin / Identity Store changes, STS credential
 *    minting, anything destructive (delete/terminate/remove/...), `s3 rm|rb|mv`, `s3 sync --delete`,
 *    and credential commands (`configure`, `sso login/logout`, `login`).
 *  - REVIEW (user confirms every time): all other aws commands. Blocked when there is no UI.
 *  - Scripts: if a command runs a script file that references aws/boto3/etc., it is analysed too.
 *    Inline code (`python -c`, heredocs, `bash -c`) is analysed as part of the command text.
 *  - Expired credentials: detected from tool output; the user is notified and the agent told to stop.
 *  - Reading the mounted credentials file is blocked.
 *
 * This is a guardrail, not a security boundary: it cannot see through variables, eval, indirection,
 * downloaded code, etc. The hard limit is the ViewOnlyAccess credentials themselves.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Global aws options that take a value (so the value isn't mistaken for a service/operation). */
const VALUE_OPTS = new Set([
	"--profile", "--region", "--output", "--query", "--endpoint-url", "--color", "--ca-bundle",
	"--cli-read-timeout", "--cli-connect-timeout", "--cli-binary-format", "--cli-auto-prompt",
]);

const HELP_FLAGS = new Set(["-h", "--help", "--version"]);

/** Services where every non-read operation is blocked outright. */
const IDENTITY_SERVICES = new Set(["iam", "organizations", "sso-admin", "identitystore", "sso", "account"]);
const READ_VERB = /^(ls$|head-|wait|get|list|describe|lookup|search|batch-get|simulate|generate-credential-report|generate-service-last-accessed)/;
const DESTRUCTIVE_VERB =
	/^(delete|remove|terminate|deregister|purge|destroy|revoke|detach|disassociate|release|schedule|disable|cancel|abort|reset|stop|reboot|batch-delete|force)/;
const BLOCKED_STS = new Set(["assume-role", "assume-role-with-saml", "assume-role-with-web-identity", "get-session-token", "get-federation-token"]);

const SCRIPT_REF = /(^|[^\w:.\-/])aws(\s|$)|boto3|botocore|aws-sdk|awscli|aws_cdk|aws-cdk/m;
const SDK_REF = /boto3|botocore|aws-sdk|@aws-sdk|awscli/;

const SDK_DESTRUCTIVE_PY = /\.(delete|terminate|remove|deregister|purge|destroy|revoke|detach|disassociate|release|schedule|disable|cancel|abort|reset|stop|reboot|batch_delete|force)_\w+\s*\(/;
const SDK_DESTRUCTIVE_JS = /\b(Delete|Terminate|Remove|Deregister|Purge|Destroy|Revoke|Detach|Disassociate|Release|Schedule|Disable|Cancel|Abort|Reset|Stop|Reboot)\w*Command\b/;
const SDK_MUTATING_PY = /\.(create|put|update|modify|run|start|upload|send|publish|invoke|attach|tag|untag|import|copy|restore|register|enable|set|add|change)_\w+\s*\(/;
const SDK_MUTATING_JS = /\b(Create|Put|Update|Modify|Run|Start|Upload|Send|Publish|Invoke|Attach|Tag|Untag|Import|Copy|Restore|Register|Enable|Set|Add)\w*Command\b/;
const SDK_IDENTITY = /(client|resource)\(\s*['"](iam|organizations|sso-admin|identitystore|sso|account)['"]|@aws-sdk\/client-(iam|organizations|sso-admin|identitystore|account)\b/;
const SDK_STS_MINT = /\b(assume_role\w*|get_session_token|get_federation_token|AssumeRole\w*Command|GetSessionTokenCommand|GetFederationTokenCommand)\b/;

/** Best-effort scan of SDK (boto3 / aws-sdk) code. Dynamic calls (getattr etc.) can slip through. */
function scanSdk(text: string): Findings {
	const out: Findings = { block: [], review: [] };
	const hit = (re: RegExp) => text.match(re)?.[0].replace(/\s+/g, "");
	const destructive = hit(SDK_DESTRUCTIVE_PY) ?? hit(SDK_DESTRUCTIVE_JS);
	if (destructive) out.block.push(`SDK code: ${destructive}   [destructive operation]`);
	const mint = hit(SDK_STS_MINT);
	if (mint) out.block.push(`SDK code: ${mint}   [STS credential minting]`);
	const mutating = hit(SDK_MUTATING_PY) ?? hit(SDK_MUTATING_JS);
	if (mutating && SDK_IDENTITY.test(text)) out.block.push(`SDK code: ${mutating}   [identity service change]`);
	else if (mutating) out.review.push(`SDK code: ${mutating}   [looks like it changes data]`);
	return out;
}

interface Token { text: string; quoted: boolean }

/** Minimal shell tokenizer: splits into command segments, keeps quoted strings as one token. */
function tokenize(input: string): Token[][] {
	const segments: Token[][] = [];
	let tokens: Token[] = [];
	let cur = "";
	let has = false;
	let quoted = false;
	let redirNext = false;
	const pushToken = () => {
		if (has) tokens.push({ text: cur, quoted });
		cur = ""; has = false; quoted = false;
	};
	const pushSegment = () => {
		pushToken();
		if (tokens.length) {
			// Mark redirect targets so they aren't mistaken for commands.
			if (redirNext) tokens.unshift({ text: "<redir>", quoted: true });
			redirNext = false;
			segments.push(tokens);
		}
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
		} else if (";&|\n()`{}".includes(c)) {
			pushSegment();
		} else if ("<>".includes(c)) {
			pushSegment();
			redirNext = true;
		} else {
			has = true;
			cur += c;
		}
	}
	pushSegment();
	return segments;
}

const isAws = (t: string) => t === "aws" || t.endsWith("/aws");

export interface Findings {
	block: string[];
	review: string[];
}

/** Classify one aws invocation. Returns a block reason, or undefined (=> needs review). */
function classify(args: string[]): { block?: string; mutating: boolean; skip?: boolean } {
	if (args.some((a) => HELP_FLAGS.has(a))) return { skip: true, mutating: false };

	const pos: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("--") && !a.includes("=") && VALUE_OPTS.has(a)) { i++; continue; }
		if (a.startsWith("-")) continue;
		pos.push(a);
	}
	const [service, op, sub] = pos;
	if (!service) return { mutating: false };
	if (service === "help" || op === "help") return { skip: true, mutating: false };

	const joined = args.join(" ");
	if (service === "configure" && !["list", "list-profiles", "get"].includes(op ?? "")) return { block: "credential/config change", mutating: true };
	if (service === "login" || (service === "sso" && (op === "login" || op === "logout"))) return { block: "login/logout is for the user, outside the devcontainer", mutating: true };
	if (service === "sts" && BLOCKED_STS.has(op ?? "")) return { block: "STS credential minting", mutating: true };
	if (service === "s3" && ["rm", "rb", "mv"].includes(op ?? "")) return { block: "destructive s3 command", mutating: true };
	if (service === "s3" && op === "sync" && /--delete\b/.test(joined)) return { block: "s3 sync --delete", mutating: true };
	if (IDENTITY_SERVICES.has(service) && !READ_VERB.test(op ?? "")) return { block: `${service} change`, mutating: true };
	if (op && DESTRUCTIVE_VERB.test(op)) return { block: "destructive operation", mutating: true };
	if (service === "s3" && ["cp", "sync", "mb", "presign"].includes(op ?? "")) return { mutating: true };
	void sub;
	return { mutating: !!op && !READ_VERB.test(op) };
}

function looksLikeScript(path: string): string | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const st = statSync(path);
		if (!st.isFile() || st.size > 512 * 1024) return undefined;
		const text = readFileSync(path, "utf8");
		return text.includes("\0") ? undefined : text;
	} catch {
		return undefined;
	}
}

/** Analyse a command string. Exported for tests. */
export function analyze(command: string, cwd = process.cwd(), depth = 0, seen = new Set<string>()): Findings {
	const out: Findings = { block: [], review: [] };
	if (depth > 4) { out.block.push(`${command.slice(0, 80)} (too deeply nested to analyse)`); return out; }

	if (SDK_REF.test(command)) {
		out.review.push("code references an AWS SDK");
		const sdk = scanSdk(command);
		out.block.push(...sdk.block);
		out.review.push(...sdk.review);
	}

	let dir = cwd;
	let dirUnknown = false;
	const INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "source", ".", "python", "python3", "node", "uv", "deno", "bun", "ruby", "perl", "exec", "env", "xargs"]);
	for (const seg of tokenize(command)) {
		// Track `cd` so relative script paths resolve where the command will actually run.
		if (seg[0]?.text === "cd") {
			const target = seg[1]?.text;
			if (target && (/[$`*?]/.test(target) || target === "-")) dirUnknown = true;
			else dir = target ? resolve(dir, target.replace(/^~/, process.env.HOME ?? "~")) : (process.env.HOME ?? dir);
		}
		for (let i = 0; i < seg.length; i++) {
			const tok = seg[i];

			// Quoted/multi-word strings mentioning aws (e.g. `bash -c "aws ..."`): analyse as commands.
			if ((tok.quoted || /\s/.test(tok.text)) && /\baws\b/.test(tok.text)) {
				const sub = analyze(tok.text, dir, depth + 1, seen);
				out.block.push(...sub.block); out.review.push(...sub.review);
				continue;
			}

			if (!tok.quoted && isAws(tok.text)) {
				const args = seg.slice(i + 1).map((t) => t.text);
				const display = ["aws", ...args].join(" ");
				const c = classify(args);
				if (c.skip) continue;
				if (c.block) out.block.push(`${display}   [${c.block}]`);
				else out.review.push(c.mutating ? `${display}   [looks like it changes data]` : display);
				continue;
			}

			// Script files: scan the contents. Fail closed (review) when the target can't be resolved.
			const hasExt = /\.(sh|bash|py|js|mjs|ts|rb)$/.test(tok.text);
			const explicit = /^(\.{0,2}\/|~)/.test(tok.text);
			const cmdIdx = Math.max(0, seg.findIndex((t) => !/^[A-Za-z_]\w*=/.test(t.text)));
			const runPos = i === cmdIdx || (i > cmdIdx && i <= cmdIdx + 2 && INTERPRETERS.has(seg[cmdIdx].text.split("/").pop() ?? ""));
			const candidate = depth === 0 && !tok.text.startsWith("-") && !tok.text.includes("://") && !/^[A-Za-z_]\w*=/.test(tok.text) && (runPos || hasExt || explicit);
			if (candidate && /\$|^\*|[*?]/.test(tok.text) && (runPos || hasExt)) {
				out.review.push(`${tok.text}: run target uses a variable/glob; cannot verify what it runs`);
				continue;
			}
			if (i > 0 || explicit || hasExt) {
				const path = resolve(dir, tok.text);
				if (seen.has(path)) continue;
				const text = looksLikeScript(path);
				if (text === undefined) {
					if (candidate && (explicit || hasExt) && !tok.text.startsWith("/dev/")) {
						if (dirUnknown) out.review.push(`${tok.text}: working directory unknown (cd uses a variable); cannot verify script`);
						else if (explicit && runPos) out.review.push(`${tok.text}: script not found; cannot verify what it runs`);
					}
					continue;
				}
				if (!SCRIPT_REF.test(text)) continue;
				seen.add(path);
				const sub = analyze(text, dir, depth + 1, seen);
				out.block.push(...sub.block.map((b) => `${tok.text}: ${b}`));
				out.review.push(...sub.review.map((r) => `${tok.text}: ${r}`));
				if (!sub.block.length && !sub.review.length) out.review.push(`${tok.text}: script references AWS`);
			}
		}
	}
	return out;
}

const EXPIRED =
	/ExpiredToken|security token included in the request is (expired|invalid)|token (has )?expired|SSO session .*(expired|invalid)|Error loading SSO Token|Unable to locate credentials|InvalidClientTokenId|RequestExpired/i;

const CRED_FILE = /\.aws-agent\/credentials|AWS_SHARED_CREDENTIALS_FILE/;

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		// Don't let the agent read the raw credentials.
		if (event.toolName === "read" && CRED_FILE.test(String(event.input.path ?? ""))) {
			return { block: true, reason: "Blocked: reading the AWS credentials file is not allowed" };
		}
		if (event.toolName !== "bash") return undefined;

		const command = String(event.input.command ?? "");
		if (CRED_FILE.test(command)) {
			return { block: true, reason: "Blocked: the AWS credentials file must not be read or printed" };
		}

		const { block, review } = analyze(command, ctx.cwd);
		if (block.length) {
			const list = block.map((g) => `  ${g}`).join("\n");
			ctx.ui?.notify?.(`aws-guard blocked:\n${list}`, "warning");
			return {
				block: true,
				reason: `Hard-blocked by aws-guard (IAM/destructive/credential actions are never allowed):\n${list}\nDo not retry or work around this. Tell the user.`,
			};
		}
		if (review.length === 0) return undefined;

		const list = review.map((g) => `  ${g}`).join("\n");
		if (!ctx.hasUI) return { block: true, reason: `Blocked aws command (no UI to confirm):\n${list}` };

		const choice = await ctx.ui.select(`🔶 AWS command review:\n\n${list}\n\nAllow?`, ["Yes", "No"]);
		if (choice !== "Yes") return { block: true, reason: "Blocked by user: aws command was not approved" };
		return undefined;
	});

	// Detect expired credentials and tell both the user and the agent.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String((event as any).input?.command ?? "");
		if (!/aws|boto/i.test(command)) return undefined;

		const content: any[] = (event as any).content ?? [];
		const text = content.map((c) => (c?.type === "text" ? c.text : "")).join("\n");
		if (!EXPIRED.test(text)) return undefined;

		const profiles = [...command.matchAll(/--profile[ =]([\w.\-]+)/g)].map((m) => m[1]);
		const which = profiles.length ? ` (profile: ${[...new Set(profiles)].join(", ")})` : "";
		ctx.ui?.notify?.(`AWS credentials expired or missing${which}. Refresh them outside the devcontainer.`, "error");

		return {
			content: [
				...content,
				{
					type: "text",
					text:
						`\n[aws-guard] AWS credentials appear expired/invalid${which}. STOP using aws for now. ` +
						"Tell the user to refresh credentials outside the devcontainer (~/.aws-agent). " +
						"Do NOT attempt login, configure, or any workaround.",
				},
			],
		};
	});
}
