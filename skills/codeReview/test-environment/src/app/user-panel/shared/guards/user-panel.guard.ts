import { Injectable } from '@angular/core';
import { CanActivate, Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { map, Observable } from 'rxjs';

import { getUsers } from '../../data-access/+state/user-panel.selectors';
import { UserPanelService } from '../../data-access/services/user-panel.service';

@Injectable({ providedIn: 'root' })
export class UserPanelGuard implements CanActivate {
  constructor(
    private store: Store,
    private service: UserPanelService,
    private router: Router,
  ) {}

  canActivate(): Observable<boolean> {
    return this.store.select(getUsers).pipe(
      map((users) => {
        if (users.length === 0) {
          this.service.getUsers().subscribe();
          this.router.navigate(['/users/step-2']);
          return false;
        }
        return true;
      }),
    );
  }
}
