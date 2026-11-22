<!-- Source: vscode-agent-plus shared/test/vscode/LOOK.md; sync-shared.js copies it, so edit it there. -->

# Reviewing a run's pictures

A script took a program's window through a series of steps and saved pictures of each. You review those pictures. You
have only this folder: `look.json`, the images it names, and this file. Do not change any code, setting or file; the
only file you write is `REVIEW.md` in this folder.

## What look.json holds

A list with one entry per step, in the order the steps ran:

- `name`: the step's name.
- `features`: the names of the features the step shows.
- `expect`: what a person should see in `image`, and what must not be there.
- `unchanged`: what must look the same as in `previous`; null when there is nothing to compare.
- `image`: a close-up of the part of the window the step is about.
- `full`: the whole window at the same moment.
- `previous`: the whole window just before the step began; null for the first step.
- `width`, `height`: the size of `image` in pixels.
- `log`: lines the program logged, and notifications that appeared, since the step before (for the first step, since
  the program started).
- `note`: present only when the script could not finish putting the window into the step's state. It says what went
  wrong; the pictures show the window as it was at that moment.

## A long run: work in parts

A run can hold far more pictures than fit in one reading session. Do not open more than about 12 steps' pictures in
one session. `previous` is usually the `full` picture of the step before; when you have already looked at that file,
you need not open it again.

- If you were given a range of steps (such as "steps 13 to 24", counted from 1 in look.json's order), review only
  those, and write `REVIEW-13-24.md` (with your range's numbers) instead of `REVIEW.md`, in the same format.
- If you were given the whole run and it has more than 12 steps, split it into ranges of at most 12. If you can start
  helper agents, give each one this folder, this file and one range; otherwise do the ranges one after another in
  fresh sessions. Then write `REVIEW.md` from the parts: every row and every finding of every part, kept as written.

## Two passes for every step

Open `image`, `full` and, when there is one, `previous`, and look at the whole of each.

**Pass 1: what was asked.**

1. Does `image` show what `expect` says, and nothing that `expect` rules out?
2. Does what `unchanged` names look the same in `full` as in `previous`?

Give one verdict: **ok**, **wrong** (what is wrong, and where), or **unsure** (why). A step with a `note` is never ok.

**Pass 2: what nobody asked about.** Do it for every step, also when pass 1 is ok. Look over `image` and `full` for:

- layout that is misaligned or shifted;
- one element covering another;
- text cut off or clipped;
- blank or empty areas where something should be;
- error, warning or "failed" text, error notifications, red marks;
- elements that are missing, or that appear twice;
- something that changed from `previous` that this step should not have changed;
- text or icons hard to read against their background;
- broken icons or images;
- anything else that would look wrong to a person seeing the window for the first time.

Then read the step's `log`, and report errors, failures, warnings and stack traces in it. Routine lines need no
mention.

The texts, times, costs and sizes in the pictures come from made-up demo data. Do not judge whether those values are
true; judge only what `expect` asks about them, for example a share that must be at most 100%. Judge only from the
pictures and the log: when something can only be told by using the program, say unsure.

Report every finding, with the image, where in it, and what is wrong. Leave out only what you are sure is fine; when
you are not sure, list it and mark it unsure.

## REVIEW.md

```markdown
# Review of <this folder's name>

## Steps

| step | pass 1 | what is wrong, or why unsure |
| --- | --- | --- |
| <name> | ok / wrong / unsure | <one or two sentences; empty for ok> |

## Findings

Every finding of both passes, the most serious first, one per line:

- **wrong** / **unsure** - <image file>, <where in it>: <what is wrong>. (pass 1 / pass 2 / log)

## Summary

<how many steps are ok, wrong and unsure; how many findings; the problems that matter most>
```

Write "None." under Findings if there are none. Keep each finding short and concrete, so that someone can find it in
the picture without asking you.
