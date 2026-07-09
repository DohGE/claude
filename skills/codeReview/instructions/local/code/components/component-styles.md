---
name: Component styles
applies-to:
  - "**/*.component.scss"
---
## Checklist
- Every component ships its own `.scss` file (even empty) next to the TS file, referenced through `styleUrl`/`styleUrls`.
- Class names are BEM-like with the component name as the root block.
- Colors come exclusively from the shared theme palette — theme CSS custom properties (`rgb(var(--...))`) or theme utility classes; never hard-coded hex/rgb values; every color added to the light palette gets a dark-mode counterpart.
- `::ng-deep` is used only wrapped in `:host { ::ng-deep { ... } }`.
- Shared sizes, breakpoints and mixins are imported from the theme with `@use`; repeated magic numbers become named SCSS variables.
- Only styles that are actually needed — no redundant declarations (e.g. `display: block` on an already-block element) and no rules duplicating what a utility class in the template already does.
