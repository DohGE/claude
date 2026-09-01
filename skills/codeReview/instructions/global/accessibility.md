---
name: Accessibility — WCAG 2.2 level AA
---
The baseline is WCAG 2.2 (https://www.w3.org/TR/WCAG22/) at conformance level AA — every level A and
level AA success criterion, including the ones added in 2.2 (2.4.11, 2.5.7, 2.5.8, 3.2.6, 3.3.7,
3.3.8). AAA criteria (2.4.12, 2.4.13, 3.3.9, 1.4.6 …) are not findings unless the reviewed project's
own `CLAUDE.md` asks for AAA. `4.1.1 Parsing` was removed in 2.2 and is never reported.

Every violation of this checklist is reported with severity 🟡 **Medium** — never softened to ⚪ Low
because it is "just markup" and never raised because the barrier looks severe. Each finding names the
violated success criterion by number in **Reguła:** (e.g. `accessibility.md → "1.4.3 Contrast (Minimum)"`).

This instruction OWNS accessibility across the whole diff — template semantics, ARIA, keyboard
operability, focus management, contrast, motion and target size. When the component template, the
component styles or any other instruction touches the same occurrence, it is reported ONCE — here,
with this severity.

Scope is the skill's scope gate: the finding is anchored on a line the diff touched. Markup, styles or
handlers the diff ADDS are reviewed even when they extend an already inaccessible structure; a barrier
living entirely in untouched lines is not a finding. Judge only what the diff itself makes checkable —
a hard-coded color pair, a declared size, a missing name, a handler bound to one input modality. Never
guess at a value that would need the running app (a themed color resolved at runtime, a screen-reader
announcement) and never report a criterion as passing or failing on a hunch.

## Checklist
- Every non-text element carries a text alternative: `<img>` has `[alt]` (empty `alt=""` only for decorative images, `aria-hidden="true"` on decorative inline `<svg>`/icon), icon-only buttons and links get an `aria-label` resolved from an i18n key, and no alternative is a filename, a key path or the word "image"/"icon" (1.1.1).
- Structure comes from semantics, not from styling: headings are real `h1`–`h6` in order without skipped levels (one `h1` per view), lists are `ul`/`ol`/`li`, tabular data is a `table` with `th` + `scope`, grouped radios/checkboxes sit in `fieldset` + `legend` — a `div` styled to look like a heading, list or table is a defect (1.3.1, 2.4.6).
- Landmarks and the document title are set for every route: `header`/`nav`/`main`/`footer` (exactly one `main`), a skip link to main content, and a unique, meaningful title through the route `title` / `Title` service; `<html lang>` is set and content in another language carries its own `lang` (2.4.1, 2.4.2, 3.1.1, 3.1.2).
- Every form control is programmatically labeled — `<label for>`, `aria-label` or `aria-labelledby`; a `placeholder` is never the only label, the label is not visually hidden away from the control it names, and required/optional state is conveyed by text or `aria-required`, not by a red asterisk alone (1.3.1, 3.3.2).
- Inputs collecting the user's own data declare the matching `autocomplete` token (`name`, `email`, `tel`, `street-address`, `postal-code`, `current-password`…) (1.3.5).
- Color is never the only carrier of meaning: error, required, selected, active and link states also differ by text, icon, underline, weight or shape (1.4.1).
- Contrast ratios of any color pair introduced or changed in the diff hold: ≥ 4.5:1 for text (≥ 3:1 for ≥ 24px, or ≥ 19px bold), ≥ 3:1 for UI component boundaries, icons, chart marks, focus indicators and state borders — a hard-coded hex/`rgb()` or a new theme token is checked against its background, not assumed (1.4.3, 1.4.11).
- Layout survives zoom and reflow: sizes in `rem`/relative units, no fixed `px` heights or `overflow: hidden` clipping translated text, content usable at 320 CSS px width (400% zoom) without two-dimensional scrolling and at 200% text zoom; the viewport meta never sets `user-scalable=no` or `maximum-scale=1`, and no layout breaks under increased line-height/letter/word spacing (1.4.4, 1.4.10, 1.4.12).
- Orientation is not locked to portrait or landscape by CSS or by a "rotate your device" screen (1.3.4).
- Tooltips, popovers and hover cards are dismissible with Escape, stay visible while the pointer moves onto them, and open on `focus` as well as `mouseenter` — a hover-only tooltip is a defect (1.4.13).
- Every interactive element is reachable and operable by keyboard: interaction sits on native `<button type="…">` / `<a href>`; a `(click)` on a `div`/`span`/icon is a finding unless the element also declares `role`, `tabindex="0"` and Enter/Space handling, and every hover-only behavior has a focus equivalent (2.1.1).
- `tabindex` is only `0` or `-1` — a positive value rewrites the focus order; DOM order matches visual order (no `order`, `row-reverse` or absolute positioning that reorders focusable content) (1.3.2, 2.4.3).
- Focus is visible: no `outline: none` / `outline: 0` without an equally visible `:focus-visible` replacement of at least 3:1 contrast against its surroundings (2.4.7, 1.4.11).
- Focus is never obscured: sticky headers, footers, toolbars and cookie bars added or resized in the diff do not cover the focused element — sticky offsets are matched by `scroll-margin`/`scroll-padding-top` (2.4.11).
- Overlays manage focus deliberately: opening a dialog/drawer/menu moves focus into it, focus cycles inside it, Escape closes it, and focus returns to the element that opened it; nothing outside it is reachable while it is open, and no other construct traps focus (2.1.2, 2.4.3).
- Drag interactions (reorderable lists, sliders, drag-and-drop, swipe) have a single-pointer and keyboard alternative — buttons, arrow keys or a select; path-based or multipoint gestures (pinch, swipe) always have a simple-pointer equivalent, and actions fire on `pointerup`/`click`, never on `pointerdown`/`mousedown` (2.5.1, 2.5.2, 2.5.7).
- Pointer targets are at least 24×24 CSS px, or spaced so that 24px circles centered on them do not overlap — an icon-only button, chip close or table row action sized below that is a finding (2.5.8).
- The accessible name contains the visible label text: an `aria-label` that replaces the visible i18n text with different wording breaks voice control — extend the visible text, don't contradict it (2.5.3).
- Single-character keyboard shortcuts (a document-level `host: { '(document:keydown.…)': '…' }` listener) can be turned off or remapped, or are active only while the relevant component has focus (2.1.4).
- Moving, auto-updating and time-limited content can be controlled: carousels, tickers, auto-advancing steps and polling counters have pause/stop, time limits can be extended, nothing flashes more than three times per second, and non-essential animation respects `prefers-reduced-motion` (2.2.1, 2.2.2, 2.3.1).
- Focus or input alone never changes context: focusing a field, selecting an option or typing must not navigate, submit, reopen a dialog or move focus — context changes come from an explicit activation (3.2.1, 3.2.2).
- Repeated components stay consistent across routes: navigation keeps the same relative order, the same function keeps the same label/icon, and a help mechanism (contact link, chat, FAQ) present on several pages keeps the same relative position (3.2.3, 3.2.4, 3.2.6).
- Validation errors are identified in text (never by red border or color alone), are programmatically tied to their control (`aria-describedby` + `aria-invalid`), suggest the correction when it is known, and a failed submit moves focus to the first invalid control or to the error summary (3.3.1, 3.3.3).
- Submissions that are legal, financial or destructive (delete, irreversible state change) are reversible, checked or confirmed before they commit (3.3.4).
- Multi-step flows never ask for information the user already entered: wizard steps and re-authentication prefill or offer the earlier value instead of requiring it to be retyped (3.3.7).
- Authentication never requires a cognitive function test without an alternative — no hand-transcribed codes, puzzles or memorization as the only path; password, OTP and email fields allow paste and autofill (`(paste)="$event.preventDefault()"`, `autocomplete="off"` or `off`-style blocking on credentials is a finding) (3.3.8).
- Custom widgets expose name, role and value: `role` matches actual behavior, required relations are present and bound to the driving signal rather than left static (`aria-expanded`, `aria-controls`, `aria-selected`, `aria-checked`, `aria-current`), ARIA attribute names and values are valid, focusable content is never inside `aria-hidden="true"`, and `role="presentation"`/`none` never lands on an interactive element — a native element is used wherever one exists instead of rebuilding it with ARIA (4.1.2).
- A control that must stay discoverable while unavailable (a submit button explaining why it is blocked) uses `aria-disabled="true"` plus a no-op handler rather than the `disabled` attribute, which removes it from the tab order and from the explanation it needs (4.1.2, 3.3.1).
- Status messages reach assistive technology without stealing focus: save results, async failures, filter result counts and validation summaries render through the shared alert/snackbar component or into an `aria-live` region (`polite`, `assertive` only for errors) that already exists in the DOM before the message is inserted (4.1.3).
- Media carries its alternatives: prerecorded video has captions and, where visuals convey information, an audio description; audio that plays automatically for more than 3 seconds can be paused or stopped (1.2.2, 1.2.5, 1.4.2).
