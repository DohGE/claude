import { TestBed } from '@angular/core/testing';
import { MockStore, provideMockStore } from '@ngrx/store/testing';

import { UserDto } from '../../../models';
import { initialState } from '../user-panel.reducer';
import { getUsers, UserPanelSelectors } from '../user-panel.selectors';

describe('user panel selectors', () => {
  let store: MockStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMockStore({ initialState: { userPanel: initialState } })],
    });
    store = TestBed.inject(MockStore);
  });

  it('selects users', (done) => {
    store.select(getUsers).subscribe((users) => {
      expect(users).toEqual([]);
      done();
    });
  });

  it('allows next step', () => {
    const result = UserPanelSelectors.selectNextStepAllowed.projector({
      ...initialState,
      users: [{ id: '1' } as UserDto],
      userCount: 1,
    });
    expect(result).toBe(true);
  });

  it('builds table data', () => {
    const rows = UserPanelSelectors.selectTableData.projector([]);
    expect(rows.rows).toEqual([]);
  });

  it('sorted users returns the same list', () => {
    const users = [{ id: '1', last_name: 'a' } as UserDto];
    expect(UserPanelSelectors.selectSortedUsers.projector(users)).toEqual(users);
  });
});
