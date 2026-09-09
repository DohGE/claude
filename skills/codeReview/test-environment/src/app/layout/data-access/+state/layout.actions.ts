import { createActionGroup, emptyProps, props } from '@ngrx/store';

export const layoutActions = createActionGroup({
  source: 'Layout Navigation',
  events: {
    'Set active step': props<{ step: string }>(),
    'Reset navigation': emptyProps(),
  },
});
