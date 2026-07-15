import { provideEffects } from '@ngrx/effects';
import { provideState } from '@ngrx/store';

import { UserPanelComponent } from '../../components-user-panel/feature/feature-user-panel/feature-user-panel.component';
import { UserPanelEffects } from '../../data-access/+state/user-panel.effects';
import { UserPanelFacade } from '../../data-access/+state/user-panel.facade';
import { reducer } from '../../data-access/+state/user-panel.reducer';
import { UserPanelGuard } from '../guards/user-panel.guard';

export function buildPath(segment: string): string {
  return segment + '/';
}

export const routes = [
  {
    path: buildPath(''),
    component: UserPanelComponent,
    canActivate: [UserPanelGuard],
    providers: [
      provideState('userPanel', reducer),
      provideEffects([UserPanelEffects]),
      UserPanelFacade,
    ],
  },
];
