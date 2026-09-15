---
name: whoa-hang-on
description: "Re-align a human who has lost the thread. Stops the task, backtracks from the agent's last message, and walks the human through the current ideas, topics, and open questions as a ladder of short, self-contained rungs, checking understanding after each rung before continuing. Use when the user says 'whoa hang on', 'I'm lost', 'I lost the thread', 'catch me up', or '/whoa-hang-on'."
version: 1.0.0
args: "Optional: what specifically lost you (a term, a question, a decision)"
user-invokable: true
---

# Whoa, Hang On

The human has lost the thread. You have been working on this and you understand more than they do right now. They need to catch up before they can be useful again. Stop the task, take a step back, and re-align them.

## Where they fell off

Assume the human was with you up until your last message. Start there and backtrack. Something in your last message, or in the work leading up to it, assumed context the human doesn't have.

If the human passed an argument, it names what lost them. Start with that.

## What alignment means

Alignment happens when the human once again understands the ideas, topics, and questions you are working with. It does not mean they know everything you know. It means they can follow your next message and answer your questions.

## How to explain

Clarity is more important than brevity. This overrides any terse or brief output style while you re-align the human.

- Be verbose. Use full sentences.
- Make every explanation self-contained. Do not write "in section 1.8", "the fix from earlier", "option B", or "as mentioned above". If you need to refer to something, restate it in full.
- Define any term or name you coined, and any name that comes from code the human hasn't read.
- Explain why, not only what: the problem being solved, what was tried, what was decided and the reason.
- Restate every open question you have asked: what the question is, why it matters, the options, and what happens with each option.

## Climb the ladder one rung at a time

Do not deliver the catch-up as one long message. A long page gives the human more places to get lost partway through. Break it into rungs and send one rung per message.

The rungs, in order:

1. **The goal.** What we are trying to accomplish, in one or two sentences.
2. **Where things stand.** What is done and what is in progress.
3. **Your last message, unpacked.** What it said and the steps that led to it, with nothing assumed. If it covered several ideas, give each idea its own rung.
4. **Open questions.** One question per rung, restated in full.

Before the first rung, tell the human how many rungs there are and name them in a short list, so they can see the whole ladder.

Each rung:

- Starts with a label that shows where the human is, like "Rung 2 of 5: Where things stand".
- Covers one idea. Explain it fully, but do not pull in the next rung's material.
- Ends by asking whether this rung makes sense and whether they are ready for the next one.

Wait for the human's reply before climbing to the next rung. If a rung isn't landing, stay on it. Ask which part is unclear and explain it a different way. Repeating the same explanation does not help. If the explanation needs more background, add a new rung below it instead of cramming the background in.

The human can also say they already understand a rung. Skip it and move on.

## Check in

After the last rung, ask the human directly whether they are caught up. Do not resume the task until they say yes.

## After they are caught up

Resume the task. The human has already lost the thread once, so it is more likely to happen again. For the rest of the session:

- Keep messages self-contained. Restate instead of referring back.
- Ask fewer questions per message.
- Before a change of topic or after a long run of work, give a short recap of where things stand.
- If a reply suggests the human is confused, offer to re-align before pushing on.
