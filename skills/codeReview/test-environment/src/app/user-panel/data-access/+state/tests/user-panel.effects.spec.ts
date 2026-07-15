import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { provideMockActions } from '@ngrx/effects/testing';
import { provideMockStore } from '@ngrx/store/testing';
import { Observable, of } from 'rxjs';

import { UserDto } from '../../../models';
import { UserPanelService } from '../../services/user-panel.service';
import { UserPanelActions } from '../user-panel.actions';
import { UserPanelEffects } from '../user-panel.effects';

const actions$: Observable<unknown> = of(UserPanelActions.loadUsers({ pageSize: 25 }));

const svc = {
  getUsers: jest.fn(() => of([{ id: '1' } as UserDto])),
  searchUsers: jest.fn(() => of([])),
} as unknown as UserPanelService;

describe('UserPanelEffects', () => {
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

  it('loads users', fakeAsync(() => {
    let result: unknown;
    effects.loadUsers.subscribe((action) => (result = action));
    tick();
    expect(svc.getUsers).toHaveBeenCalled();
    expect(result).toBeDefined();
  }));
});
