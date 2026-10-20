---
name: explain-it
description: "Set a repo up for animated explainers, start a new explainer, or open one in the browser, using the @explain-it/core CLI. An explainer is a step-through animation of a technical design (a protocol, a contract, an architecture) that a human watches one beat at a time. Use when the user says '/explain-it setup', '/explain-it new <name>', '/explain-it view [name]', or asks to set up, create, start, open, view, or launch an explainer."
version: 1.0.0
args: "setup | new <name> | view [name]"
user-invokable: true
---

# Explain It

A human wants an explainer: an animated walk-through of a technical design, shown one beat at a time with a caption under each. This skill is how they get one going. It runs the `@explain-it/core` CLI through `npx`, so nothing needs installing first.

An explainer is only content and config: a folder with `explainer.config.ts` and `sections/<id>.tsx`, inside the repo's explainers folder (named in `explain-it.config.ts` at the repo root, usually `docs/explainers/`).

Run every command from the repo, as `npx @explain-it/core <command>`. Show the human the command's output when it matters, and say plainly what happened.

## The argument

The first word of the argument picks what to do. Anything after it is the name.

- `setup`: set the repo up.
- `new <name>`: start an explainer.
- `view [name]`: open one in the browser.
- Nothing, or anything else: say what the three do, in one line each, and ask which the human wants.

## setup

Run `npx @explain-it/core setup` at the repo root. It writes:

- `explain-it.config.ts`: the explainers folder, `docs/explainers` by default
- two `.gitignore` lines for the folders explainers generate
- a line in `CLAUDE.md` telling agents to read the authoring guide

It is safe to run again; it only adds what's missing. If the human wants explainers somewhere other than `docs/explainers`, pass `--explainers <folder>`.

Tell the human what it wrote, and that `/explain-it new <name>` starts an explainer.

## new <name>

The name is the explainer's folder: lowercase letters, digits and dashes, like `live-contract`. If the human gave words instead, suggest a name made from them and confirm it.

1. **Ask what it explains.** Ask what design the explainer is about, and where the document that describes it is: a file in the repo, a section of one, or a link. The explainer follows that document, so this matters more than anything else. If there's no document, ask the human to describe the design, and keep their description as the source.
2. **Create it.** Run `npx @explain-it/core new <name>`. If it says the repo isn't set up, offer to run `setup` first.
3. **Read the guide.** Run `npx @explain-it/core guide` and read all of it. It is the authoring guide for the version that runs, and every rule in it applies from here on.
4. **Write the outline, and stop.** Following the guide's workflow, read the source and write the sections and every beat's id and caption, with empty bodies. Run `npx @explain-it/core outline` and show the human the story. Then stop and ask them to approve or change it. Don't animate until they approve the outline: changing the story is cheap now, and expensive once it's animated.

After the human approves, carry on with the rest of the guide's workflow (animate, snap, look, check), and offer `/explain-it view <name>` so they can watch it.

## view [name]

Run `npx @explain-it/core view <name> --no-open` in the background, so the session stays free. Leave the name off when the human didn't give one: with one explainer in the repo, it opens that one.

When several explainers exist and no name was given, `view` lists them and exits. Show the human the list and ask which one, then run it again with the name.

When the server prints its address, give the human the URL, and tell them how to move around:

- the timeline across the top picks a section
- Next, Back or the arrow keys step one beat at a time
- the dots between Back and Next replay a beat

It keeps running until the session ends or the human asks you to stop it. Edits to the explainer reload in the page at the beat that was showing.
