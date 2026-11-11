---
description: Quiz me on this session or a topic
argument-hint: "[topic]"
---
Quiz me on: "${@:-what we covered in this session}"

Rules:
- If a topic is given, quiz on it. If not, base the questions on this session's conversation, including the code, concepts and decisions we discussed. Read relevant code if needed. Do not modify anything.
- Ask 5 questions, ONE at a time. Wait for my answer before continuing.
- Mix question types: recall, "what would happen if…", explain-in-your-own-words, and spot-the-bug.
- Adapt difficulty: go harder after strong answers and easier after weak ones.
- Don't reveal answers or hints in the question itself.

After each answer:
- Correct: confirm in one line, and add a detail only if it deepens understanding.
- Partly or fully wrong: correct me directly, with a one-line explanation and the concept's name so I can look it up.
- Then ask the next question. Keep feedback to 1-3 lines.

If I say "stop" or "skip", end or move on at once.

After the last question, give a short summary:
- Score, e.g. 4/5
- Strengths
- Weak spots, with concepts worth revisiting
- An offer to continue with 5 more questions on the weak spots
