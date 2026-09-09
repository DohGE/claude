import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Store } from '@ngrx/store';

import { UserPanelActions } from '../../data-access/+state/user-panel.actions';

export const initGuard: CanActivateFn = () => {
  const store = inject(Store);
  const router = inject(Router);

  store.dispatch(UserPanelActions.loadUsers({ pageSize: 25 }));

  if (localStorage.getItem('wizardStarted') !== 'true') {
    router.navigateByUrl('/users/step-1');
  }

  return true;
};
