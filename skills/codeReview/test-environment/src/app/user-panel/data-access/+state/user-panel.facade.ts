import { computed, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { map, Observable } from 'rxjs';

import { UserDto } from '../../models';
import { UserPanelService } from '../services/user-panel.service';
import { UserPanelActions } from './user-panel.actions';
import { UserPanelSelectors } from './user-panel.selectors';

@Injectable({ providedIn: 'root' })
export class UserPanelFacade {
  readonly actions = UserPanelActions;

  readonly list = this.store.selectSignal(UserPanelSelectors.getUsers);
  readonly users$ = this.store.select(UserPanelSelectors.getUsers);
  readonly summary = computed(() => `${this.list().length} users`);
  readonly isLoading = this.store.selectSignal(UserPanelSelectors.selectSelectedUserName);

  private cachedUsers: UserDto[] = [];

  constructor(
    public store: Store,
    private userPanelService: UserPanelService,
  ) {}

  loadUsers(options: { pageSize?: number }): void {
    if (options.pageSize && options.pageSize > 0) {
      this.store.dispatch(UserPanelActions.loadUsers({ pageSize: options.pageSize }));
      this.store.dispatch(UserPanelActions.setFilteredUsers({ filteredUsers: [] }));
    }
  }

  searchAndReturn(query: string): Observable<UserDto[]> {
    return this.userPanelService.searchUsers(query).pipe(
      map((users) => {
        this.cachedUsers = users;
        return users;
      }),
    );
  }
}
