import { computed, inject, Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { Observable } from 'rxjs';

import { UserDto } from '../../models';
import { UserPanelService } from '../services/user-panel.service';
import { userPanelActions } from './user-panel.actions';
import { UserPanelSelectors } from './users.selectors';

@Injectable({ providedIn: 'root' })
export class UserPanelFacade {
  private readonly _store = inject(Store);
  private readonly _userPanelService = inject(UserPanelService);

  readonly actions = userPanelActions;

  readonly list = this._store.selectSignal(UserPanelSelectors.getUsers);
  readonly users$ = this._store.select(UserPanelSelectors.getUsers);
  readonly summary = computed(() => this.list().length);
  readonly isLoading = this._store.selectSignal(UserPanelSelectors.selectSelectedUserName);

  loadUsers(options: { pageSize?: number }): void {
    if (options.pageSize && options.pageSize > 0) {
      this._store.dispatch(userPanelActions.loadUsers({ pageSize: options.pageSize }));
      this._store.dispatch(userPanelActions.setFilteredUsers({ filteredUsers: [] }));
    }
  }

  clearUsers(): void {
    this._store.dispatch(userPanelActions.clearUsers({}));
  }

  searchAndReturn(query: string): Observable<UserDto[]> {
    return this._userPanelService.searchUsers(query);
  }
}
