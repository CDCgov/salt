---
title: Survey Logic
description: A complete guide to skip logic, validation, skip-to, and eligibility conditions using JEXL expressions.
---

SALT lets you control four things with short written conditions:

- **Skip a question**: hide it for some participants.
- **Check an answer**: reject an answer that does not make sense.
- **Skip ahead**: jump past a block of questions.
- **Decide eligibility**: let only the intended participants take the survey.

You write these conditions in the survey editor, for example, `age >= 18`. You do not need to be a programmer, but you do need to follow the rules in this guide carefully: a wrong condition quietly changes who sees what.

The conditions are written in a small, widely-used expression language called **JEXL**. This guide covers everything you need; the full language reference is at <https://commons.apache.org/proper/commons-jexl/reference/syntax.html>.

---

## Where you write logic

Open a question in the survey editor (the **question edit modal**). Near the bottom are three logic fields:

![Question edit modal showing logic fields](../../../assets/screenshots/admin-surveys-question-edit-logic.png)

| Field in the question edit modal | What it does |
|----------------------------------|--------------|
| **Skip Logic** | Hides this question when the condition is true. |
| **Skip-To Expression** + **Skip-To Target** | After this question is answered, jumps to another question. |
| **Validation Script** | Decides whether the answer just entered is accepted. |

Eligibility is set once for the whole survey, in the **Eligibility Settings** card of the editor:

| Field | What it does |
|-------|--------------|
| **Eligibility Script** | After the eligibility questions, decides whether the participant may continue. |

Leave any of these blank and it does nothing, the question always shows, every answer is accepted, no jump.

---

## Referring to a question's answer

Every question has a **Short Name**: a field in the question edit modal, a short label such as `age` or `tsres`. In a condition, you refer to a participant's answer by typing that Short Name.

Short Names are **case-sensitive**: type them exactly as they were set.

---

## What an answer looks like

When you name a question in a condition, you get the participant's answer to that question:

- **Multiple choice**: you get the **number of the option they chose**. Options are numbered **starting at 0**: the first option in the list is `0`, the second is `1`, the third is `2`, and so on. So `sex == 1` means "the participant chose the **second** option of the question named `sex`."
- **Numeric**: the number they entered.
- **Text**: the text they typed.
- **Multi-select**: the set of options they ticked (each option still numbered from 0). See [Multi-select questions](#multi-select-questions).
- **A question with no answer**: one that was skipped, or one that comes later in the survey, counts as *nothing*. A comparison against it is simply false.

> **Options are numbered from 0, not 1. This is the most common mistake.**
> The first option is `0`. If a question lists *Yes* then *No*, then *Yes* is `0` and *No* is `1`. If you are unsure what number an option has, use the [logic tester](#testing-your-logic): it shows you.

---

## Facility and seed variables

Besides your questions' Short Names, every condition can use three built-in variables. Their names start with `_`:

| Variable | What it holds | Example |
|---|---|---|
| `_facility_name` | The name of the tablet's facility, exactly as it appears on the **Facilities** page | `_facility_name == 'Clinic A'` |
| `_facility_id` | The facility's **ID** from the Facilities page | `_facility_id == 3` |
| `_is_seed` | `true` if the participant came without a referral coupon (a seed), `false` if they brought one | `_is_seed`, or `!_is_seed` for recruits |

They work everywhere: skip logic, validation, skip-to, eligibility and coupon count scripts, and lab test conditions. For example, `_is_seed && age < 18` is true for seeds under 18, and `_facility_name =~ ['Clinic A', 'Clinic B']` is true at either clinic.

- **Prefer `_facility_id` for logic that must keep working.** If a facility is renamed, or its name is typed slightly differently, a condition using `_facility_name` silently stops matching. The ID never changes.
- **Short Names cannot start with `_`**, so a question can never hide these variables.
- **Update the tablets first.** Tablets running an older version of the SALT app don't know these variables, and a condition that uses one fails there. Make sure every tablet has the current app before activating a survey that uses them.

---

## Writing conditions

A condition compares values and produces a yes/no (true/false) result.

| To do this | Use |
|------------|-----|
| Is equal to / is not equal to | `==`  `!=` |
| Less than / greater than | `<`  `<=`  `>`  `>=` |
| **Both** parts must be true | `&&` |
| **Either** part may be true | `\|\|` |
| Not / the opposite of | `!` |
| Group parts together | `( … )` |

Examples:

- `age >= 18`, the answer to `age` is 18 or more.
- `sex == 1 && age >= 18`, `sex` is the second option **and** `age` is at least 18.
- `result == 0 || result == 2`, `result` is the first **or** the third option.

Text values must be in quotes: `nationality == 'Ugandan'`.

---

## Skip Logic, hiding a question

The **Skip Logic** field hides the question when its condition is **true**.

> Skip Logic is a *skip-when* rule. Write the condition under which the question should **not** appear, not the condition under which it should.

Examples from the CRANE MSM survey:

- On the question `elmssxt` (last anal sex), Skip Logic `eltgsx != 0`. `eltgsx` ("ever had sex") has *Yes* as its first option (`0`), so this hides `elmssxt` whenever the participant did **not** answer *Yes*.
- On `condno` ("why no condom"), Skip Logic `cond != 1`. `cond` has *No* as its second option (`1`), so `condno` is asked only after a *No*.

---

## Validation Script, checking an answer

The **Validation Script** runs after the participant enters an answer. If the condition is **true**, the answer is accepted. If it is false, the answer is rejected and the participant must correct it before continuing.

Inside a Validation Script, the answer being checked is called **`value`**:

- On a numeric age question: `value >= 15 && value <= 89`
- On a "how many people" question whose answer cannot exceed an earlier count: `value >= 0 && value <= dgbehav`

`value` is a reserved word; the editor will not let you give a question the Short Name `value`.

> Take extra care with Validation Scripts: a mistake in one rejects **every** answer, leaving the participant unable to continue. Always [test it](#testing-your-logic).

---

## Skip-To, jumping ahead

Skip-To leaps over a run of questions in one step. It uses two fields in the question edit modal:

- **Skip-To Expression**: a condition.
- **Skip-To Target**: the **Short Name** of the question to jump to.

After the question is answered (and passes its Validation Script), if the Skip-To Expression is **true**, the survey jumps straight to the Skip-To Target and everything in between is passed over. If false, the survey continues normally.

The answer just given is available as **`value`** here too.

Example: on `tsevno`, asked only of people who have never tested for HIV, the Skip-To Expression jumps the participant ahead to the PrEP block (Skip-To Target `prmss`), past the HIV-treatment questions for people who have tested.

**Skip Logic vs Skip-To:** use **Skip Logic** to drop a single question; use **Skip-To** to leap over a whole block at once.

---

## Eligibility Script

The **Eligibility Script**, in the Eligibility Settings card, runs once after the eligibility questions. If it is **true**, the participant is eligible and continues; if false, they are shown the ineligibility message and the survey ends.

A new survey starts with no Eligibility Script, which means **every participant is eligible**. **Check survey** warns about this until you write one.

It can use the Short Name of any eligibility question. The CRANE MSM survey uses:

```
tutsex == 1 && tutage >= 18 && eltgsx == 0 && elmssxt == 0
  && (elcoup == 0 || elcoup == 1)
```

, the second option for `tutsex` (male), at least 18, *Yes* to having had sex, and so on.

The ineligibility message itself is edited on the **System Messages** tab, as the "Ineligibility Message".

---

## Multi-select questions

A multi-select answer is the **set of options the participant ticked**. To test whether a particular option was ticked, use `=~`, which means "is among":

- `2 =~ q`, option number 2 (the third option) was ticked.
- `2 =~ q || 4 =~ q`, option 2 **or** option 4 was ticked.
- `2 =~ q && 4 =~ q`, option 2 **and** option 4 were both ticked.
- `q.contains(2)`, the same as `2 =~ q`.
- `size(q)` or `q.size()`, how many options were ticked. `empty(q)`, none were.

Two forms look right but are not:

- `q == 2` is never true, because the answer is a list, not a single number.
- `q =~ [2, 4]` (list on the right) is true when **every** ticked option is 2 or 4, and also when nothing was ticked. To test one option, put the number first: `2 =~ q`.

These are the only functions you can call in a script: `=~`, `.contains()`, `.size()`, `size()` and `empty()`.

The question edit modal also has **Minimum Selections** and **Maximum Selections** fields to limit how many options may be ticked.

---

## "Other, specify" text

An option on a multiple-choice or multi-select question can be marked **Other (free text)** in the survey editor (see [Survey Questions](/management/survey-questions/)). The text the participant types into its box is available as **`<short name>_other`**. For the question `q10`, that is `q10_other`. It works in every script: Skip Logic, Validation Script, Skip-To, Eligibility Script and the coupon count script.

- `q10_other` is **text**, so compare it with quotes: `q10_other == 'Nurse'`.
- It is **nothing (null)** when the other option is not selected, or when the participant left the box blank.
- `q10` itself does not change. It is still the **option number** (from 0) for multiple choice, or the set of option numbers for multi-select.

Example: the other option is the sixth option (`5`) of `q10`. `q10 == 5 && q10_other == null` means the participant chose "Other" but typed nothing.

Because `q10_other` is reserved for this, the editor will not let you give another question the Short Name `q10_other` when `q10` has an other option.

---

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Counting options from 1 | The first option is `0`, the second is `1`. |
| Treating Skip Logic as "show when" | It **hides** the question when true, write the skip-*when* condition. |
| A typo in a Short Name, or wrong upper/lower case | Type Short Names exactly as set. |
| Forgetting quotes around text | `nationality == 'Ugandan'`, not `nationality == Ugandan`. |
| A broken Validation Script | Older tablets reject every answer. Use **Check survey** in the editor before publishing. |
| `=` instead of `==` | `a = 1` changes the answer instead of comparing it. The checker rejects it. |
| Comparing an answer that may have been skipped with `<`, `>`, `<=` or `>=` | A skipped answer is blank, and comparing a blank is an error on the tablet. Check it first: `x != null && x > 2`. |
| Using a question asked later | It has no answer yet. Eligibility can only use eligibility-section questions. |

---

## Checking your logic in the web app

The survey editor checks every script with the same JEXL library the tablet uses, so mistakes are caught before a survey reaches tablets.

- **As you type:** when you leave a script box, problems appear under it.
- **Check survey:** the button above the question list checks every script in the survey. Click a problem to open that question. The editor also runs this check when it opens and shows the list if anything is wrong.
- **On save and import:** the save or import still goes through, and the message lists any problems.
- **On activation:** a survey with **errors** cannot be activated. Warnings don't block it.

**Errors** are scripts that cannot work: syntax errors, a Short Name that doesn't exist, `=` instead of `==`, `value` outside a Validation or Skip-To script, a function that isn't allowed, or a Skip-To target that is missing or not after the question.

**Warnings** are scripts that run but probably don't do what you meant: `==` on a multi-select, an option number the question doesn't have, a question asked later, `<` or `>` on an answer that may have been skipped, `<` or `>` on "other" text, `.contains()` on a question that isn't multi-select, and question or option text missing in one of the survey's languages.

Lab test conditions are checked against the active survey when you leave the condition box. In a lab test condition a multiple choice answer is the option's **text**, not its number.

If Java is not installed on the server, scripts are not checked and the editor says so. Saving and activation still work.

---

## Testing your logic

The tablet has a built-in **logic tester** that shows every condition as the survey runs.

**To turn it on:** on the tablet, log in as an administrator, open **Developer Settings**, and switch on **Debug Conditional Statements**.

![Developer Settings screen showing Debug Conditional Statements toggle](../../../assets/screenshots/tablet-admin-developer-settings.png)

With it on, each time the survey reaches a Skip Logic, Validation Script, Skip-To, or Eligibility condition, a window appears showing:

- **Context**: a table of every question's Short Name and the participant's current answer. This is the surest way to see what number an option produced.
- **Statement**: the condition itself. You can edit it here to try variations and see the result change; edits made here are for testing only and are **not saved**.
- **Result**: what the condition currently works out to, or an error message if the condition is written incorrectly.

Tap **Continue** to let the survey proceed.

Turn **Debug Conditional Statements** back **off** before real data collection, otherwise staff are interrupted by this window at every condition.
