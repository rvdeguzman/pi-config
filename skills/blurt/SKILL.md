---
name: blurt
description: Run a blurting study round for any course or subject. The user recalls a topic from memory, then you check it strictly against the course's own sources, point to the gaps, quiz only the gaps, and log scores and review dates. Use for /blurt, "blurt", "blurting", or "test me on what I remember about X".
---

# Blurt

Blurting means the user writes everything they remember about a topic with nothing open. Then they compare it against the source, fix the gaps, and recall those gaps again. You are the strict, honest checker, not a tutor who explains things up front. The value comes from the user's own recall, so never give content away before they blurt.

Arguments: a topic (slug, number or words), a path to a round file to grade, or nothing.

## 0. Find the study root

The study root is the nearest directory, starting at the cwd and walking up, that contains `blurts/log.org`. All paths below are relative to it.

If no study root exists, set one up in the cwd, which should be the course directory. If the cwd isn't a course directory, ask which one to use.
1. Survey the course: READMEs, the syllabus or outline, the schedule, notes, slides, textbooks, assignments and solutions, and any study guides. Use a scout subagent if there are many files.
2. Copy [log-template.org](log-template.org) to `blurts/log.org` and fill it in:
   - **Exams:** dates, format and weight, taken from the course files.
   - **Sources:** references in order of authority, with paths, page-number offsets (PDF page versus printed page), the notation conventions the course uses, and any tools that can verify answers.
   - **Topics:** one row per topic, at the granularity of a lecture or book section, with the reference for each.
3. Show the topic table in one short message and continue to Phase 1. The user can edit the table later.

## Phase 1: cue

1. Read `blurts/log.org`.
2. Pick the topic:
   - If the argument is a path to an existing round file, go to Phase 2 and grade it.
   - If it names a topic, use it. If that topic is not in the table, add a row.
   - If there is no argument, pick an overdue topic first, then one never blurted, then the lowest score.
3. Create `blurts/<YYYY-MM-DD>-<slug>.org` from the round template in `log.org`.
4. Reply with only these items: the topic title, the source sections it covers, the file path, and this instruction: "Write or dictate everything you remember (definitions, key results, how things work and why, examples, common mistakes). Paste it here or save the file and say done. Don't look anything up."
5. Don't read the reference yet, and don't list subtopics, headings or hints. If the user asks for a hint, give one word or concept name and record it as hinted.

## Phase 2: check

1. If the user pasted the blurt, write it verbatim into `* Blurt`. If they said done, read the file.
2. Read the topic's references as listed under Sources. Build the answer key from them, not from memory: the 8–15 items the course's exam would most likely test, given the exam format. Typical items:
   - formal definitions with every component
   - theorem, law or model statements with their conditions
   - procedures and algorithms, step by step
   - mechanisms and cause→effect chains
   - formulas and what each symbol means
   - the canonical examples the course uses
   - distinctions between easily confused ideas, and the traps the sources warn about
3. Mark each key item:
   - `✓` recalled correctly
   - `~` partly right or vague; say exactly what is missing
   - `✗` wrong; give the correction in one or two lines with a source chip (book page, slide number or note heading)
   - `∅` not mentioned; give only a pointer to where it is, not the content
   Also flag any false claim the user made, even if it isn't on the key. Don't penalize notation style or typing shortcuts. Do penalize missing conditions, swapped quantifiers, reversed directions and wrong signs. If a correction involves something concrete you can compute (an automaton, a derivation, a number), verify it with a tool when one is listed under Sources.
4. Score = ✓ count + 0.5 × ~ count, out of the key size. Write the check into `* Check` as an Org checklist and show it to the user.
5. Tell the user to read the pointed-to sources for the `∅` and `~` items and then say ready. Explain missing content yourself only if they ask.

## Phase 3: gap round

1. Ask 3–5 short recall questions on only the `∅`, `~` and `✗` items. Mix the forms: state a definition, finish a statement, apply a step, and spot the error in a claim. Match the exam's style; for a multiple-choice exam, include one or two multiple-choice questions. Reuse practice questions from the course files if any exist, without showing their answers.
2. Grade the answers the same way and record the questions, answers and marks in `* Gap round`.

## Phase 4: log

1. Update the topic's row in `log.org` with the date, the score and the next review date. Use these intervals: 1 day if the score is below 60%, 3 days if it is 60–85%, and 7 days if it is above 85%. Never schedule past the next exam listed under Exams; make the date the day before it at the latest.
2. Under `* Open gaps`, replace the topic's list with every item still not `✓`, written as `- [ ]` checkboxes. In the next round on that topic, check those items first and tick off the ones the user now recalls.
3. Finish with one line: score, gaps still open, and next review date.

## Rules

- Keep replies short. Be strict: a vague answer that would lose marks on the exam is `~`, not `✓`.
- Use the course's conventions and notation, not another textbook's.
- Don't modify course materials. Only write under `blurts/`.
- Follow the workspace's file-format rules if they differ from Org.
