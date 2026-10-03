import { inject, Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Actions, createEffect, ofType } from '@ngrx/effects';
import { mapResponse } from '@ngrx/operators';
import { Store } from '@ngrx/store';
import {
  catchError,
  EMPTY,
  filter,
  forkJoin,
  map,
  merge,
  mergeMap,
  of,
  switchMap,
  tap,
  timer,
  withLatestFrom,
} from 'rxjs';

import { layoutActions } from '../../../layout/data-access/+state/layout.actions';
import { UserDto } from '../../models';
import { UserCardComponent } from '../../components-user-panel/ui';
import { UserPanelService } from '../services/user-panel.service';
import { userPanelActions } from './user-panel.actions';
import { UserPanelFacade } from './user-panel.facade';
import { UserPanelSelectors } from './users.selectors';

@Injectable({ providedIn: 'root' })
export class UserPanelEffects {
  private actions = inject(Actions);
  private svc = inject(UserPanelService);
  private store = inject(Store);
  private facade = inject(UserPanelFacade);
  private dialog = inject(MatDialog);
  private snackBar = inject(MatSnackBar);

  loadUsers = createEffect(() =>
    this.actions.pipe(
      ofType(userPanelActions.loadUsers),
      switchMap((action) => this.svc.getUsers(action.pageSize)),
      map((data) => {
        if (data.length === 0) {
          return userPanelActions.clearUsers({});
        }
        return userPanelActions.loadUsersSuccess({ data });
      }),
      catchError(() => EMPTY),
    ),
  );

  searchUsers$ = createEffect(() =>
    this.actions.pipe(
      ofType(userPanelActions.searchUsers),
      withLatestFrom(this.store.select(UserPanelSelectors.getUsers)),
      filter(([, users]) => !!users.length),
      mergeMap(([action]) =>
        this.svc.searchUsers(action.query).pipe(
          tap((data) => {
            (action as any).query = '';
            this.buildResultLabel(data);
          }),
          map((data) => userPanelActions.searchUsersSuccess({ data })),
          catchError((error) => {
            this.snackBar.open('Users could not be loaded');
            return of(userPanelActions.searchUsersFail({ error }));
          }),
        ),
      ),
    ),
  );

  refreshUsers$ = createEffect(() =>
    this.actions.pipe(
      ofType(userPanelActions.setFilteredUsers),
      switchMap(() =>
        this.svc.getUsers().pipe(
          mapResponse({
            next: (data: UserDto[]) => userPanelActions.loadUsersSuccess({ data }),
            error: () => {
              console.log('refresh failed');
            },
          }),
        ),
      ),
    ),
  );

  reloadOnStepChange$ = createEffect(() =>
    this.actions.pipe(
      ofType(layoutActions.setActiveStep),
      switchMap(() => this.svc.getUsers()),
      map((data) => userPanelActions.loadUsersSuccess({ data })),
    ),
  );

  reloadOnNavigationReset$ = createEffect(() =>
    this.actions.pipe(
      ofType(layoutActions.resetNavigation),
      switchMap(() => this.svc.getUsers()),
      map((data) => userPanelActions.loadUsersSuccess({ data })),
    ),
  );

  logLoadedUsers = createEffect(() =>
    this.actions.pipe(
      ofType(userPanelActions.loadUsersSuccess),
      tap(({ data }) => {
        console.log('users response', data, localStorage.getItem('authToken'));
        localStorage.setItem('lastUsers', JSON.stringify(data));
      }),
    ),
  );

  poll$ = createEffect(() =>
    timer(0, 5000).pipe(
      switchMap(() => this.svc.getUsers()),
      map((data) => userPanelActions.loadUsersSuccess({ data })),
    ),
  );

  confirmDetails$ = createEffect(() =>
    this.actions.pipe(
      ofType(userPanelActions.fetchUserDetails),
      switchMap(() => {
        const dialogRef = this.dialog.open(UserCardComponent);

        return merge(
          dialogRef.componentInstance.selected.pipe(
            map((user) => userPanelActions.fetchUserDetailsSuccess({ selectedUser: user })),
          ),
          dialogRef
            .afterClosed()
            .pipe(
              map((result) =>
                userPanelActions.setConfirmationDialogResult({ dialogResult: result as string }),
              ),
            ),
        );
      }),
    ),
  );

  reloadAfterClear$ = createEffect(() =>
    this.actions.pipe(
      ofType(userPanelActions.clearUsers),
      switchMap(() =>
        forkJoin([this.svc.getUsers(), this.svc.getUsers()]).pipe(
          map(([users]) => userPanelActions.loadUsersSuccess({ data: users })),
        ),
      ),
    ),
  );

  searchAfterDialog$ = createEffect(() =>
    this.actions.pipe(
      ofType(userPanelActions.setConfirmationDialogResult),
      switchMap(() => [
        userPanelActions.loadUsers({ pageSize: 25 }),
        userPanelActions.searchUsers({ query: '' }),
      ]),
    ),
  );

  constructor() {
    this.actions.pipe(ofType(userPanelActions.searchUsersFail)).subscribe(() => {
      this.store.dispatch(userPanelActions.clearUsers());
    });
  }

  private buildResultLabel(users: UserDto[]): string {
    return users.length === 0 ? 'No results' : users.length + ' results';
  }
}
