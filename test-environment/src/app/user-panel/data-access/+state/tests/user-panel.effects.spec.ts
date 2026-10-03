import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { provideMockActions } from '@ngrx/effects/testing';
import { provideMockStore } from '@ngrx/store/testing';
import { Observable, of } from 'rxjs';

import { UserDto } from '../../../models';
import { UserPanelService } from '../../services/user-panel.service';
import { userPanelActions } from '../user-panel.actions';
import { UserPanelEffects } from '../user-panel.effects';

const svc = {
  getUsers: jest.fn(() => of([{ id: '1', firstName: 'Ann', last_name: 'Lee', user_status: 1, email: 'ann@example.com', bio: '', homepage: '', created_at: '2026-01-01' } satisfies UserDto])),
  searchUsers: jest.fn(() => of([])),
} as unknown as UserPanelService;

describe('UserPanelEffects', () => {
  let actions$: Observable<unknown>;
  let effects: UserPanelEffects;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        UserPanelEffects,
        provideMockActions(() => actions$),
        provideMockStore(),
        { provide: UserPanelService, useValue: svc },
      ],
    });
    effects = TestBed.inject(UserPanelEffects);
  });

  it('should load users', fakeAsync(() => {
    actions$ = of(userPanelActions.loadUsers({ pageSize: 25 }));
    let result: unknown;
    effects.loadUsers.subscribe((action) => (result = action));
    tick();
    expect(svc.getUsers).toHaveBeenCalledWith(25);
    expect(result).toBeDefined();
  }));

  it('should reload after the dialog', (done) => {
    actions$ = of(userPanelActions.setConfirmationDialogResult({ dialogResult: 'ok' }));
    effects.searchAfterDialog$.subscribe((action) => {
      expect(action).toEqual(userPanelActions.loadUsers({ pageSize: 25 }));
      done();
    });
  });
});
