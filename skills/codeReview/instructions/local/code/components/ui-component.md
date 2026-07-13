---
name: UI (presentational) component
applies-to:
  - "**/ui/**/*.component.ts"
---
## Checklist
- Folder and file are `ui-<segment>/ui-<segment>.component.*`, class `Ui<PascalCase>Component`, selector `<app-prefix>-ui-<segment>`.
- Purely presentational: exchanges data exclusively through `input()`/`output()`; never injects a facade, the store, or HTTP/data services; holds no business/domain logic and performs no data fetching, navigation, or state mutation — it only renders its inputs and emits user interactions as outputs, leaving all decisions to the parent feature component.
- Owns the whole view logic for its fragment: its own form with validators, its `dataTestPrefix` (own const or `input()` from the parent), presentational `computed()`/signals, and UI event handling.
- Form contract with the parent: input→form via `effect(() => control.setValue/patchValue(value(), { emitEvent: false }))`; form→parent via `valueChanges` piped through `takeUntilDestroyed(this._destroyRef)` (plus `debounceTime` from the central app config and/or `distinctUntilChanged(...)` where appropriate) emitting an `output()`.
- A disabled/locked input is applied with `effect(() => { if (isDisabled()) form.disable({ emitEvent: false }); })`.
- A component whose form participates in aggregate validation is marked with the shared form-reference tracking decorator and implements the matching interface.
- Emitted values are typed with models from `models/`; no local duplicate interfaces.
- All common component rules apply (OnPush, signal inputs/outputs, member order, readonly fields, separate template/styles).
