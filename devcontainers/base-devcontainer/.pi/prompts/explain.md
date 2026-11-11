---
description: Explain code or a concept, then let me pick what to dive into
argument-hint: "<file, symbol or concept> [familiarity note]"
---
Explain $1 to a senior engineer. Familiarity note from the user (may be empty): "${@:2}". If present, adjust depth to it.

If $1 is a file or symbol, read the actual code first. If it's a concept, explain it generally and tie it to this repo only where relevant. Do not modify anything.

Format:
- Start with a short overview: the purpose and how it works, in at most 5 bullets.
- Use headings and bullets. No paragraph longer than 3 sentences.
- Name the patterns and principles involved so I can look them up.

Then end with a menu of areas to explore further, with a one-line teaser for each. Pick only those that are relevant:
1. Design decisions: why it's built this way
2. Alternatives and trade-offs
3. Failure modes and edge cases
4. Execution walkthrough
5. Further reading: primary sources

Ask me which to dive into. Don't expand any of them until I choose.
