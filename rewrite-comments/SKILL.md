---
name: rewrite-comments
description: Rewrite existing source-code comments so readers understand the feature's context, what the code does, and why. Use when a user asks to clarify or improve one comment or a selected set of comments, while preserving code behavior.
---

# Rewrite Comments

Write for a developer who can read the language but does not already know this
feature. Introduce the situation before explaining the implementation.

## Identify the comment(s) to rewrite

Accept ordinary descriptions, pasted comments, or optional source references:

- `assets/css/theme.css:886` selects the complete comment containing that line.
- `assets/css/theme.css:885-912` selects all comments intersecting that range;
  include each whole comment even if it extends beyond the range.

If a line is just outside a comment, use the clearly intended adjacent comment;
clarify only when the target is ambiguous. Use conversation context to resolve
other descriptions.

## Establish the context

Start with what the conversation already establishes about the feature and
the intended behavior. Read the requested comments and relevant code to locate
the target and check the explanation. Inspect surrounding implementation,
callers, settings, templates, or tests only as needed to fill gaps or resolve
conflicting evidence; do not repeat an investigation already established in
the conversation. Existing comments are claims to check, not proof of behavior.

Identify what the feature lets someone do, what activates this code, and why
this implementation exists. If the reason cannot be established from the
available evidence, describe the verified behavior without inventing a motive.

## Explain in a useful order

Use this progression where it helps; a simple comment may need only a sentence:

1. **Context:** name the feature, relevant objects, and user choice or situation.
   Explain terms such as "shared format" before relying on them. Use actual
   interface labels when they help connect the comment to the feature.
2. **Behavior:** explain the consequence in concrete terms. For example,
   "each opening image fills its column's width" is clearer than "normalise
   leading-image geometry".
3. **Reason:** explain the intended result or the problem the rule prevents.
   Distinguish a layout choice from a technical necessity; do not say something
   "needs" a rule merely because the implementation currently uses it.
4. **Scope and exceptions:** retain the conditions, precedence, and escape
   routes that matter to a future edit. Explain wrappers, selectors, or other
   mechanics after the feature context, when those details explain the code.

Use connected sentences and concrete nouns. Remove repeated explanations and
history that does not clarify current behavior. Avoid merely narrating syntax.
Do not compress the explanation just to preserve old line numbers, or expand a
straightforward comment into an essay.

## Make a focused edit

Rewrite only the requested comments and directly connected comment text needed
for clarity. Preserve code.
Keep the project's comment language and conventions.
Do not touch comments that are :
- tooling behavior (such as lint suppressions, compiler directives)
- structured documentation tags
- license notices.
- TODO / FIXME
- commented-out code

If the user asks only for an explanation or proposed wording, provide that
instead of editing files.

## Example

Suppose the source confirms a card section offers a common image proportion,
forces full column width while that option is selected, and restores saved
dimensions when it is cleared.

Before:

```css
/* A shared image format needs full-width leading images. */
```

After:

```css
/* The card section has an image at the top of each column. Editors can choose
 * common proportions for those images, such as square or portrait, in the
 * section's settings.
 *
 * While that option is selected, these images fill their column's width.
 * Equal-width columns with the same proportions then have equal image heights.
 * Saved width and height settings are overridden to keep that layout consistent.
 * Clearing the option restores individual sizing. */
```

The example demonstrates the explanation style; establish the actual behavior
and terminology from the source for each task.
