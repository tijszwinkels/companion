---
name: task-retrospective
description: >-
  Look back at a finished task or session when the user asks for a
  retrospective: what went well, what caused friction or mistakes, and which
  lessons are worth keeping. Proposes small, reviewable changes to instructions
  or skills; applies them only with the user's approval.
license: GPL-3.0-only
---

# Task retrospective

Help the next similar task go more smoothly. Run when the user asks for a
retrospective, or offer one briefly after a long or bumpy task; do not run it
automatically or on a schedule. This is not a daily report or a required step in
any workflow.

## 1. Gather evidence

Use the current conversation: the request, tool failures and retries, the user's
corrections, wrong assumptions and how the result was verified. Use an earlier
session only if the user points to it. Do not search unrelated history. If part
of the conversation is no longer available, say so instead of filling the gap.

## 2. Find the few lessons that matter

- Group repeated symptoms under one cause. Separate what the evidence shows from
  your guesses.
- Keep a lesson only if it is likely to recur and a short instruction would
  prevent it. One-off accidents and things the agent already does well do not
  need new rules.
- Note what went well if it is worth repeating.

## 3. Propose, don't impose

For each lesson, propose the smallest change and where it belongs:

- the user's own instructions for this kind of work;
- a project's instruction file, for project-specific facts;
- an existing skill, or rarely a new one, for a reusable procedure.

Read the target file first and check that the lesson is not already covered or
contradicted. Show the exact wording and location. Preserve existing
instructions; prefer a precise addition over rewriting.

Apply a change only after the user approves it. Ask separately before editing
global instructions or a skill shared with other agents or people. Never change
instructions as a side effect of a retrospective, and do not start other agents
to carry it out.

## 4. Report

Summarize briefly: what happened, the lessons, what was changed and where, and
what was proposed but not applied.
