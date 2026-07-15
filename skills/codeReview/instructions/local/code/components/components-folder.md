---
name: Components folder contents
applies-to:
  - "**/components*/**"
---
## Checklist
- Inside `components-<area>/{feature,ui}/<component-name>/` only `*.component.ts`, `*.component.html`, `*.component.scss` and a `tests/` folder may exist. Any other file (helpers, consts, interfaces, enums, utils, local models) is a violation by its mere existence, regardless of the quality of its content.
- For such a misplaced file, additionally report where each of its declarations belongs: interfaces/types/enums/consts → `models/`, pure functions → `shared/utils/`, state logic → `data-access/+state/`, user-facing texts → i18n keys.
- No `index.ts` barrel anywhere under `components-<area>/` — consumers import concrete component files; a barrel here also drags `@defer`-loaded components into the eager bundle.
