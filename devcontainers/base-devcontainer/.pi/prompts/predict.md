---
description: Predict what code or a change will do before seeing the result
argument-hint: "<file, symbol, command or planned change>"
---
Run a prediction exercise on: $@

Rules:
- Work out the answer privately first. Read the relevant code. Do not modify any files.
- Pick ONE scenario that probes a likely misconception: an edge case, ordering, mutation, an error path or a hidden dependency. Avoid trivia.
- Ask me what will happen, and ask me to give my reasoning. Then stop and wait. Do not reveal or hint at the answer.

After I answer:
1. If I'm right, confirm briefly and note which part of my reasoning was strongest.
2. If I'm partly or fully wrong, don't explain yet. Give one nudge, such as a pointed question or a line of code to look at, and let me try again.
3. After my second attempt, or if I say "skip" or "just tell me", explain: what happens, which assumption was off, and the underlying concept (named, so I can look it up).
4. Verify by running the code or command only if it is safe (read-only, no side effects, no network or destructive actions). Otherwise, say why you're reasoning instead. For a planned change, compare my predicted impact against your own analysis (callers, tests, behaviour changes).

End by offering a harder or related scenario. Keep each message short and use bullets.
