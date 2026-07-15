import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { Store } from '@ngrx/store';
import { EMPTY, forkJoin, of, timer } from 'rxjs';
import { catchError, filter, map, mergeMap, switchMap, tap, withLatestFrom } from 'rxjs/operators';

import { UserDto } from '../../models';
import { UserCardComponent } from '../../components-user-panel/ui';
import { UserPanelService } from '../services/user-panel.service';
import { UserPanelActions } from './user-panel.actions';
import { UserPanelFacade } from './user-panel.facade';
import { UserPanelSelectors } from './user-panel.selectors';

@Injectable({ providedIn: 'root' })
export class UserPanelEffects {
  private actions = inject(Actions);
  private svc = inject(UserPanelService);
  private store = inject(Store);
  private facade = inject(UserPanelFacade);
  private dialog = inject(MatDialog);

  loadUsers = createEffect(() =>
    this.actions.pipe(
      ofType(UserPanelActions.loadUsers),
      switchMap((action) => this.svc.getUsers(action.pageSize)),
      map((data) => UserPanelActions.loadUsersSuccess({ data })),
      catchError(() => EMPTY),
    ),
  );

  searchUsers$ = createEffect(() =>
    this.actions.pipe(
      ofType(UserPanelActions.searchUsers),
      withLatestFrom(this.store.select(UserPanelSelectors.getUsers)),
      filter(([, users]) => !!users.length),
      mergeMap(([action]) =>
        this.svc.searchUsers(action.query).pipe(
          tap((data) => {
            (action as any).query = '';
            this.buildResultLabel(data);
          }),
          map((data) =>
            UserPanelActions.searchUsersSuccess({ data, receivedAt: Date.now() } as any),
          ),
          catchError((error) => of(UserPanelActions.searchUsersFail({ error }))),
        ),
      ),
    ),
  );

  logLoadedUsers = createEffect(() =>
    this.actions.pipe(
      ofType(UserPanelActions.loadUsersSuccess),
      tap(({ data }) => {
        console.log('users response', data, localStorage.getItem('authToken'));
        localStorage.setItem('lastUsers', JSON.stringify(data));
      }),
    ),
  );

  poll$ = createEffect(() =>
    timer(0, 5000).pipe(
      switchMap(() => this.svc.getUsers()),
      map((data) => UserPanelActions.loadUsersSuccess({ data })),
    ),
  );

  confirmDetails$ = createEffect(() =>
    this.actions.pipe(
      ofType(UserPanelActions.fetchUserDetails),
      switchMap(() =>
        this.dialog
          .open(UserCardComponent)
          .afterClosed()
          .pipe(
            map((result) =>
              UserPanelActions.setConfirmationDialogResult({ dialogResult: result as string }),
            ),
          ),
      ),
    ),
  );

  reloadAfterClear$ = createEffect(() =>
    this.actions.pipe(
      ofType(UserPanelActions.clearUsers),
      switchMap(() =>
        forkJoin([this.svc.getUsers(), this.svc.getUsers()]).pipe(
          map(([users]) => UserPanelActions.loadUsersSuccess({ data: users })),
        ),
      ),
    ),
  );

  constructor() {
    this.actions.pipe(ofType(UserPanelActions.searchUsersFail)).subscribe(() => {
      this.store.dispatch(UserPanelActions.clearUsers());
    });
  }

  private buildResultLabel(users: UserDto[]): string {
    return users.length === 0 ? 'No results' : users.length + ' results';
  }
}
