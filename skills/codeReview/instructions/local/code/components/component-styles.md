---
name: Component styles
applies-to:
  - "**/*.component.scss"
  - "**/*.component.ts"
gate: the file declares CSS - a stylesheet, or a component TS whose decorator carries an inline `styles: [...]` array
---
## Checklist
- (Inline `styles: [...]` in a component decorator is CSS and is walked against every item below; that those styles belong in a `.scss` file at all is the component instruction's rule, reported there.)
- (The existence of the `.scss` file and its `styleUrl` reference are owned by the component instruction — report a missing file there, not here.)
- Class names are BEM-like with the component name as the root block.
- Colors come exclusively from the shared theme palette — theme CSS custom properties (`rgb(var(--...))`) or theme utility classes; never hard-coded hex/rgb values; every color added to the light palette gets a dark-mode counterpart.
- `::ng-deep` is used only wrapped in `:host { ::ng-deep { ... } }`.
- Shared sizes, breakpoints and mixins are imported from the theme with `@use`; repeated magic numbers become named SCSS variables.
- Only styles that are actually needed — no redundant declarations (e.g. `display: block` on an already-block element) and no rules duplicating what a utility class in the template already does.
