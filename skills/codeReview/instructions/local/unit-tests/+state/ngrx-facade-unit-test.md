---
name: NgRx facade unit test
applies-to:
  - "**/*.facade.spec.ts"
---
## Checklist
- The store mock is `const storeMock: Partial<Store> = { dispatch: jest.fn(), selectSignal: jest.fn(() => signal(null)), select: jest.fn(() => of(null)) }`; setup is `MockBuilder(Facade).mock(Store, storeMock)` in `beforeAll` and `facade = MockRender(Facade).point.componentInstance`.
- One flat `it` per public method at the top `describe` level (no nested `describe`s for a proxy class).
- Every assertion is `expect(storeMock.dispatch).toHaveBeenCalledWith(actions.x({ ...exact payload }))` — never a bare `toHaveBeenCalled()` (it would pass for the wrong action).
- Methods with nullable parameters have two tests: a concrete value and `null`.
- No-payload methods assert `actions.x()`; multi-argument methods assert the full positional-argument→payload-field mapping.
- Array/complex payloads use complete domain fixtures; `{} as X` casts are acceptable (the facade never reads payload fields).
- Signals are not tested (the mock returns `signal(null)`; selector logic has its own spec, component behavior mocks the facade); no `expect.objectContaining`/`expect.any`.
- `afterEach` runs `jest.clearAllMocks()` (otherwise the null-branch assertion sees the previous call).
