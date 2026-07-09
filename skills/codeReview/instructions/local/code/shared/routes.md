---
name: Route definitions
applies-to:
  - "**/*.routes.ts"
---
## Checklist
- The export is `<camelCaseArea>Routes: Routes`; components are loaded lazily with `loadComponent: () => import('...').then((c) => c.<Component>)`.
- Simple-page variant (`shared/routes/<area>.routes.ts`): thin and stateless — a single `path: ''` entry with `loadComponent` pointing at the wrapper feature component; **zero** `providers`, `provideState`, `provideEffects`, facades or `canActivate` (the parent registers state and guards at its `loadChildren`).
- Wizard variant (`shell/<area>-shell.routes.ts`): one entry per step with `path` taken from the step enum, `canActivate` guards declared in this file (initialization guard factory + previous-step guard), and `loadComponent` per step; state, effects and the facade are still provided by the parent at `loadChildren`.
- An area has either `shared/routes/` or `shell/` — never both.
- Where state is registered (the parent route), the `providers` array holds `provideState(featureKey, reducer)`, `provideEffects([ ...all effect classes of the area ])` and the facade together.
- Import paths inside route files may be relative within the area or aliased when crossing areas; no other logic lives in a routes file.
- Route files have no unit specs — lazy-load correctness is verified by the build.
