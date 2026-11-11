---
description: Trace the execution flow of a script, CLI command, IaC stack or deployment
argument-hint: "<entrypoint or question> [step]"
---
Trace the execution flow for: $@

Entrypoints may be a bash script or CLI command, a CDK app, stack or construct, a CloudFormation template or resource, a Sceptre stack config, or a free-text question such as "what happens when I run make deploy". If it isn't a clear entrypoint, find it first and say what you chose. Read the actual files. Do not modify anything.

Cover the main flow only. Skip utilities and library internals. Flag key branches inline.

Context to include where relevant:
- Bash/CLI: `set -e` and error handling, exit codes, sourced files, subshells, env vars, traps, and flags that change the flow
- CDK: construct tree, synth-time vs deploy-time behaviour, assets, and the handoff to CloudFormation
- CloudFormation: dependency ordering (Ref, GetAtt, DependsOn), conditions, custom resources, and rollback behaviour
- Sceptre: config layering, template rendering, resolvers, hooks, dependencies, and the handoff to CloudFormation

Output format:
1. A one-line scope statement: the entrypoint, and what you assumed.
2. A Mermaid `flowchart TD` of the main flow. Show branches as decision nodes, with labelled edges.
3. A numbered list matching the diagram's steps. Each item has `file:line` and a one-line note.
4. A menu of steps I could dive into, with a one-line teaser each. Don't expand any until I choose.

If my arguments include the word "step": don't show the diagram or the list at first. Walk the flow one hop at a time. At each hop, ask me what happens next, and wait. Use the nudge-then-explain approach from `/predict` if I'm wrong. Show the complete diagram at the end.
