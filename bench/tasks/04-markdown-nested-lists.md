# Task 04: nested lists in a small Markdown renderer

**Expected difficulty:** medium

## Goal

A tiny Markdown to HTML renderer handles flat lists only. Make it render nested lists correctly.

## Starting state

A zero-dependency package `mdlite` with `src/render.js` (about 150 lines) exporting `render(markdown)`. It handles headings, paragraphs, emphasis, inline code, links and flat unordered and ordered lists. Block parsing is a single pass over lines with a few regexes. 31 visible tests pass. Indented list lines are currently treated as paragraph continuation.

## Acceptance criteria

1. A list item indented by 2 or more spaces more than its parent becomes a nested list inside the parent `<li>`.
2. Nesting works to at least 4 levels and can mix unordered and ordered lists.
3. Returning to a lower indentation closes the deeper lists correctly.
4. Inline formatting inside nested items still works.
5. Output for all existing inputs is byte for byte unchanged (the visible snapshot tests must not be edited).
6. HTML special characters in list text are still escaped.
7. New visible tests cover points 1 to 3. Only `src/` and `test/` change.

## Hidden test

`hidden/nested-lists.hidden.test.js` compares exact HTML output for about 15 documents: two level and four level nesting, an ordered list inside an unordered one, a dedent by more than one level at once, a nested list followed by a paragraph, tabs treated as 4 spaces, `<script>` text inside a nested item (must be escaped), and a document with 2,000 list lines that must render in under 500 ms. A trap test checks that a code block containing indented list-looking lines is left alone.
