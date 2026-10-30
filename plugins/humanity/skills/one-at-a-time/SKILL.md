---
name: one-at-a-time
description: "Slow down and hand the human one item at a time. Use when a list of questions, a page of notes, or a batch of decisions is too much to take in at once. Breaks the pile into single items, rewrites each so it reads on its own with no cross-references or shorthand, and waits for the human to deal with each before showing the next. Use when the user says 'one at a time', 'too much', 'slow down', 'one by one', or '/one-at-a-time'."
version: 1.0.0
args: "Optional: which list or message to break up, if not your last one"
user-invokable: true
---

# One at a Time

The human is telling you the last thing you gave them was too big. Maybe a list of questions, a page of notes, or a set of decisions. They want to work through it, but not all at once. The goal is to get each item processed: answered, decided, or acknowledged. Then move to the next.

This can mean the human is tired. Make each item easy to pick up and easy to put down.

## What to break up

Assume it is your last message. If the human passed an argument, it names what to break up instead.

Pull out every item that needs something from the human: a question to answer, a decision to make, a note to read and acknowledge. Drop filler, recaps, and anything that needs no response.

Order the items so earlier answers can shape later ones. If an item depends on another, put the one it depends on first. Otherwise put the most important or most blocking item first.

## Rewrite each item so it stands alone

Each item gets rewritten, not copied. Someone reading only that one item should understand it without scrolling up.

- No cross-references. Do not write "see question 3", "the option from earlier", "as above", or "per the notes". Restate the thing in full.
- No shorthand. Expand abbreviations and acronyms you or the thread coined. Replace nicknames for files, functions, or ideas with what they actually are.
- Say why it matters in a sentence. What happens with each answer, if it is a choice.
- If it is a choice, list the options plainly and say which one you recommend.
- Keep it short. One item, a few lines. If it needs more than that, it is probably two items.

## Hand them over one per message

First, send a short message saying how many items there are, with a one-line title for each. Then give the first item in the same message.

Each item:

- Starts with a label like "1 of 6: Database for session storage".
- Covers exactly one thing.
- Ends by asking for the answer, decision, or a go-ahead for the next item.

Wait for the human's reply before sending the next item. Do not preview the next item.

When they reply:

- Record their answer. Act on it now only if it is quick and needed for the next item. Otherwise hold it.
- If the answer changes or settles a later item, update or drop that item and say so in one line.
- If they say "skip" or "later", park it and move on.
- If they want to stop, stop. List what is answered and what is left.

## After the last item

Give a short summary: each item's title and the answer or decision, plus anything parked. Then carry on with the work.

For the rest of the session, keep the habit. Fewer questions per message, plain words, no references back to earlier messages.
