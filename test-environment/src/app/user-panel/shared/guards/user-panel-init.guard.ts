import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';

import { UserPanelFacade } from '../../data-access/+state/user-panel.facade';

export const initGuard: CanActivateFn = () => inject(UserPanelFacade).list().length > 0;
