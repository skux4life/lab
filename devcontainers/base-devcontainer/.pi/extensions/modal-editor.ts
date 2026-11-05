/**
 * Modal Editor - vim-like modal editing for the pi prompt editor.
 *
 * Insert mode: everything passes through. Escape → normal mode.
 *
 * Normal mode:
 *   Counts      : {n}<cmd>, e.g. 3w, 2dd, d3w, 3x
 *   Motions     : h j k l  w W b B e E  0 ^ $  gg G ({n}G / {n}gg → line n)
 *   Operators   : d c y + motion, dd cc yy, D C, x X
 *   Put / undo  : p P, u
 *   Insert      : i a I A o O
 *   Escape      : clears a pending count/operator; otherwise passes through (aborts agent)
 *   Enter, ctrl+* etc. pass through to the editor/app.
 *   k on the first line / j on the last line browse prompt history.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Word motions (pure functions over flat text offsets)
// 0 = whitespace, 1 = punctuation, 2 = word char. "Big" = any non-whitespace.
// ---------------------------------------------------------------------------
function charClass(ch: string, big: boolean): number {
	if (/\s/.test(ch)) return 0;
	if (big) return 2;
	return /\w/.test(ch) ? 2 : 1;
}

function nextWordStart(text: string, pos: number, big: boolean): number {
	const n = text.length;
	if (pos >= n) return pos;
	const cls = charClass(text[pos]!, big);
	let i = pos;
	if (cls !== 0) while (i < n && charClass(text[i]!, big) === cls) i++;
	while (i < n && charClass(text[i]!, big) === 0) i++;
	return i;
}

function wordEnd(text: string, pos: number, big: boolean): number {
	const n = text.length;
	let i = pos + 1;
	while (i < n && charClass(text[i]!, big) === 0) i++;
	if (i >= n) return Math.max(pos, n - 1);
	const cls = charClass(text[i]!, big);
	while (i + 1 < n && charClass(text[i + 1]!, big) === cls) i++;
	return i;
}

function prevWordStart(text: string, pos: number, big: boolean): number {
	let i = pos - 1;
	while (i > 0 && charClass(text[i]!, big) === 0) i--;
	if (i <= 0) return 0;
	const cls = charClass(text[i]!, big);
	while (i > 0 && charClass(text[i - 1]!, big) === cls) i--;
	return i;
}

const MOTION_KEYS = new Set(["h", "l", "j", "k", "w", "W", "b", "B", "e", "E", "0", "^", "$", "G", "gg"]);

type Op = "d" | "c" | "y";

interface Motion {
	target: number; // flat offset
	inclusive: boolean; // include the char at target in operator ranges
	linewise: boolean;
	targetLine: number;
}

class ModalEditor extends CustomEditor {
	private mode: "normal" | "insert" = "insert";
	private count = ""; // digits typed so far
	private opCount = 1; // count typed before the operator (d3w vs 3dw)
	private op: Op | null = null;
	private pendingG = false;
	private register = { text: "", linewise: false };

	// ---------------- input routing ----------------
	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.mode = "normal";
			} else if (this.count || this.op || this.pendingG) {
				this.resetPending();
			} else {
				super.handleInput(data); // abort agent, etc.
			}
			return;
		}

		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		// Control sequences / Enter / arrows pass through
		if (data.length !== 1 || data.charCodeAt(0) < 32) {
			this.resetPending();
			super.handleInput(data);
			return;
		}

		this.handleNormal(data);
	}

	private resetPending(): void {
		this.count = "";
		this.opCount = 1;
		this.op = null;
		this.pendingG = false;
	}

	private takeCount(): { n: number; explicit: boolean } {
		const explicit = this.count !== "" || this.opCount !== 1;
		const n = this.opCount * (this.count ? parseInt(this.count, 10) : 1);
		return { n, explicit };
	}

	private handleNormal(key: string): void {
		// Counts ("0" is a motion unless a count is in progress)
		if (/[1-9]/.test(key) || (key === "0" && this.count)) {
			this.count += key;
			return;
		}

		// g-prefix
		if (this.pendingG) {
			this.pendingG = false;
			if (key === "g") this.motionCommand("gg");
			else this.resetPending();
			return;
		}
		if (key === "g") {
			this.pendingG = true;
			return;
		}

		// Operator pending
		if (this.op) {
			if (key === this.op) this.lineOperator();
			else if (MOTION_KEYS.has(key)) this.motionCommand(key);
			else this.resetPending();
			return;
		}

		if (key === "d" || key === "c" || key === "y") {
			this.op = key;
			this.opCount = this.count ? parseInt(this.count, 10) : 1;
			this.count = "";
			return;
		}

		if (MOTION_KEYS.has(key)) {
			this.motionCommand(key);
			return;
		}

		const { n } = this.takeCount();
		this.resetPending();
		const { text, pos, line, lineStart, lineEnd } = this.ctx();

		switch (key) {
			case "i":
				this.mode = "insert";
				break;
			case "a":
				this.setPos(Math.min(lineEnd, pos + 1));
				this.mode = "insert";
				break;
			case "I":
				this.setPos(this.firstNonBlank(line));
				this.mode = "insert";
				break;
			case "A":
				this.setPos(lineEnd);
				this.mode = "insert";
				break;
			case "o":
				this.applyEdit(text.slice(0, lineEnd) + "\n" + text.slice(lineEnd), lineEnd + 1);
				this.mode = "insert";
				break;
			case "O":
				this.applyEdit(text.slice(0, lineStart) + "\n" + text.slice(lineStart), lineStart);
				this.mode = "insert";
				break;
			case "x":
				if (pos < lineEnd) this.applyRange("d", pos, Math.min(lineEnd, pos + n), false);
				break;
			case "X":
				if (pos > lineStart) this.applyRange("d", Math.max(lineStart, pos - n), pos, false);
				break;
			case "D":
				this.applyRange("d", pos, this.lineEndOffset(Math.min(line + n - 1, this.getLines().length - 1)), false);
				break;
			case "C":
				this.applyRange("c", pos, this.lineEndOffset(Math.min(line + n - 1, this.getLines().length - 1)), false);
				break;
			case "p":
			case "P":
				this.put(key === "p", n);
				break;
			case "u": {
				const self = this as any;
				for (let i = 0; i < n; i++) {
					if (typeof self.undo === "function") self.undo();
					else super.handleInput("\x1f"); // ctrl+- (default undo)
				}
				break;
			}
			// anything else: ignore printable chars in normal mode
		}
	}

	// ---------------- motions ----------------
	private motionCommand(key: string): void {
		const { n, explicit } = this.takeCount();
		const op = this.op;
		this.resetPending();

		const c = this.ctx();
		const lines = this.getLines();

		// History browsing at the edges (no operator)
		if (!op && key === "k" && c.line === 0) {
			super.handleInput("\x1b[A");
			return;
		}
		if (!op && key === "j" && c.line === lines.length - 1) {
			super.handleInput("\x1b[B");
			return;
		}

		// cw / cW behave like ce / cE when on a non-blank (vim quirk)
		let k = key;
		if (op === "c" && (k === "w" || k === "W") && c.pos < c.text.length && !/\s/.test(c.text[c.pos]!)) {
			k = k === "w" ? "e" : "E";
		}

		const m = this.computeMotion(k, n, explicit, c);
		if (!m) return;

		if (!op) {
			// Normal-mode cursor sits on a character, never past the end of the line
			const ls = this.offsetOf(m.targetLine, 0);
			const le = this.lineEndOffset(m.targetLine);
			this.setPos(Math.max(ls, Math.min(m.target, le - 1)));
			return;
		}

		if (m.linewise) {
			this.applyLines(op, Math.min(c.line, m.targetLine), Math.max(c.line, m.targetLine));
			return;
		}

		let start = Math.min(c.pos, m.target);
		let end = Math.max(c.pos, m.target);
		if (m.inclusive && m.target >= c.pos) end = Math.min(c.text.length, end + 1);
		// dw at the end of a line shouldn't eat the newline
		if ((k === "w" || k === "W") && m.target > c.pos) {
			const nl = c.text.indexOf("\n", c.pos);
			if (nl !== -1 && nl < end && nl > c.pos) end = nl;
		}
		if (start === end) return;
		this.applyRange(op, start, end, false);
	}

	private computeMotion(
		key: string,
		n: number,
		explicit: boolean,
		c: ReturnType<ModalEditor["ctx"]>,
	): Motion | null {
		const lines = this.getLines();
		const last = lines.length - 1;
		const charwise = (target: number, inclusive = false): Motion => ({
			target,
			inclusive,
			linewise: false,
			targetLine: this.lineOf(target),
		});
		const linewise = (targetLine: number, col?: number): Motion => {
			const l = Math.max(0, Math.min(last, targetLine));
			const target =
				col === undefined ? this.firstNonBlank(l) : this.offsetOf(l, Math.min(col, lines[l]!.length));
			return { target, inclusive: false, linewise: true, targetLine: l };
		};
		const repeat = (f: (p: number) => number) => {
			let p = c.pos;
			for (let i = 0; i < n; i++) p = f(p);
			return p;
		};

		switch (key) {
			case "h":
				return charwise(Math.max(c.lineStart, c.pos - n));
			case "l":
				return charwise(Math.min(c.lineEnd, c.pos + n));
			case "j":
				return linewise(c.line + n, c.col);
			case "k":
				return linewise(c.line - n, c.col);
			case "w":
				return charwise(repeat((p) => nextWordStart(c.text, p, false)));
			case "W":
				return charwise(repeat((p) => nextWordStart(c.text, p, true)));
			case "e":
				return charwise(repeat((p) => wordEnd(c.text, p, false)), true);
			case "E":
				return charwise(repeat((p) => wordEnd(c.text, p, true)), true);
			case "b":
				return charwise(repeat((p) => prevWordStart(c.text, p, false)));
			case "B":
				return charwise(repeat((p) => prevWordStart(c.text, p, true)));
			case "0":
				return charwise(c.lineStart);
			case "^":
				return charwise(this.firstNonBlank(c.line));
			case "$":
				return charwise(this.lineEndOffset(Math.min(last, c.line + n - 1)));
			case "gg":
				return linewise(explicit ? n - 1 : 0);
			case "G":
				return linewise(explicit ? n - 1 : last);
		}
		return null;
	}

	// ---------------- operators ----------------
	private lineOperator(): void {
		const { n } = this.takeCount();
		const op = this.op!;
		this.resetPending();
		const { line } = this.ctx();
		this.applyLines(op, line, Math.min(this.getLines().length - 1, line + n - 1));
	}

	private applyRange(op: Op, start: number, end: number, linewise: boolean): void {
		const text = this.flat();
		this.register = { text: text.slice(start, end), linewise };
		if (op === "y") {
			this.setPos(start);
			return;
		}
		this.applyEdit(text.slice(0, start) + text.slice(end), start);
		if (op === "c") this.mode = "insert";
	}

	private applyLines(op: Op, first: number, lastLine: number): void {
		const lines = this.getLines();
		const removed = lines.slice(first, lastLine + 1);
		this.register = { text: removed.join("\n") + "\n", linewise: true };

		if (op === "y") {
			this.setPos(this.offsetOf(first, 0));
			return;
		}

		const kept = [...lines.slice(0, first), ...(op === "c" ? [""] : []), ...lines.slice(lastLine + 1)];
		const newLines = kept.length ? kept : [""];
		const cursorLine = Math.min(first, newLines.length - 1);
		this.applyEdit(newLines.join("\n"), 0);
		this.setPos(op === "c" ? this.offsetOf(cursorLine, 0) : this.firstNonBlank(cursorLine));
		if (op === "c") this.mode = "insert";
	}

	private put(after: boolean, n: number): void {
		const { text } = this.register;
		if (!text) return;
		const c = this.ctx();

		if (this.register.linewise) {
			const lines = this.getLines();
			const regLines = text.replace(/\n$/, "").split("\n");
			const insert: string[] = [];
			for (let i = 0; i < n; i++) insert.push(...regLines);
			const at = after ? c.line + 1 : c.line;
			const newLines = [...lines.slice(0, at), ...insert, ...lines.slice(at)];
			this.applyEdit(newLines.join("\n"), 0);
			this.setPos(this.firstNonBlank(at));
			return;
		}

		const chunk = text.repeat(n);
		const at = after && c.pos < c.lineEnd ? c.pos + 1 : c.pos;
		this.applyEdit(c.text.slice(0, at) + chunk + c.text.slice(at), at + chunk.length - 1);
	}

	// ---------------- editor state helpers ----------------
	private flat(): string {
		return this.getLines().join("\n");
	}

	private offsetOf(line: number, col: number): number {
		const lines = this.getLines();
		let off = col;
		for (let i = 0; i < line; i++) off += lines[i]!.length + 1;
		return off;
	}

	private lineOf(offset: number): number {
		const lines = this.getLines();
		let off = 0;
		for (let i = 0; i < lines.length; i++) {
			if (offset <= off + lines[i]!.length) return i;
			off += lines[i]!.length + 1;
		}
		return lines.length - 1;
	}

	private lineEndOffset(line: number): number {
		return this.offsetOf(line, this.getLines()[line]!.length);
	}

	private firstNonBlank(line: number): number {
		const l = this.getLines()[line] ?? "";
		const m = l.match(/^\s*/);
		return this.offsetOf(line, Math.min(m ? m[0].length : 0, l.length));
	}

	private ctx() {
		const lines = this.getLines();
		const { line, col } = this.getCursor();
		const text = lines.join("\n");
		const lineStart = this.offsetOf(line, 0);
		return { text, lines, line, col, pos: lineStart + col, lineStart, lineEnd: lineStart + lines[line]!.length };
	}

	/** Move cursor to a flat offset (uses editor internals; falls back to arrow keys). */
	private setPos(offset: number): void {
		const lines = this.getLines();
		const target = Math.max(0, Math.min(offset, lines.join("\n").length));
		const line = this.lineOf(target);
		const col = target - this.offsetOf(line, 0);
		const self = this as any;
		if (self.state && typeof self.setCursorCol === "function") {
			self.state.cursorLine = line;
			self.setCursorCol(col);
			self.lastAction = null;
			return;
		}
		// Fallback: arrow keys
		const { pos } = this.ctx();
		const seq = target > pos ? "\x1b[C" : "\x1b[D";
		for (let i = 0; i < Math.abs(target - pos); i++) super.handleInput(seq);
	}

	/** Replace the text atomically (one undo step), keeping paste markers intact. */
	private applyEdit(newText: string, cursor: number): void {
		const self = this as any;
		const pastes = self.pastes instanceof Map ? new Map(self.pastes) : null;
		const pasteCounter = self.pasteCounter;
		this.setText(newText);
		if (pastes) {
			for (const [k, v] of pastes) self.pastes.set(k, v);
			self.pasteCounter = pasteCounter;
		}
		this.setPos(cursor);
	}

	// ---------------- rendering ----------------
	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;

		const pending = `${this.opCount !== 1 ? this.opCount : ""}${this.op ?? ""}${this.count}${this.pendingG ? "g" : ""}`;
		const label = this.mode === "normal" ? ` NORMAL${pending ? ` ${pending}` : ""} ` : " INSERT ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => new ModalEditor(tui, theme, kb));
	});
}
