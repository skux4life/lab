---
description: Senior-engineer review of the current diff, a file or a branch
argument-hint: "[file | branch vs main | focus, e.g. security]"
---
Review my code as a senior engineer. Request: "$@"

Scope:
- If the request is empty, review the current diff (`git diff HEAD`, which includes staged and unstaged changes).
- If it names a file, review that file. If it names a branch or base (e.g. "branch vs main"), review that diff.
- If it names a focus (e.g. security, concurrency, naming), prioritise it, but still flag anything severe.
- Read surrounding code where needed for context. Do not modify anything.

Response format (keep it short and scannable):
- Start with a one-line scope statement: what you reviewed.
- Then a tiered list of findings, one line each: `[#] location: issue`
  - **Must fix:** bugs, security problems, data loss, broken contracts
  - **Should fix:** design, maintainability, error handling, missing tests
  - **Nit:** style and minor polish
- No explanations, fixes or code in this first response.
- Then ask which finding(s) I want to explore.
- If there are no findings, say so briefly. Don't invent nits.

When I pick a finding, explain it in a few bullets:
- What's wrong and where
- Why it matters (the realistic consequence)
- The principle or pattern behind it, named so I can look it up
- A direction for the fix, in words rather than code, unless I ask for code
