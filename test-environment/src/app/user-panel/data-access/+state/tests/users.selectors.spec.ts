import { TestBed } from '@angular/core/testing';
import { MockStore, provideMockStore } from '@ngrx/store/testing';

import { UserDto } from '../../../models';
import { initialState } from '../user-panel.reducer';
import { getUsers, UserPanelSelectors, UserPanelTableQuery } from '../users.selectors';

describe('user panel selectors', () => {
  let store: MockStore;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMockStore({ initialState: { userPanel: initialState } })],
    });
    store = TestBed.inject(MockStore);
  });

  it('should select users', (done) => {
    store.select(getUsers).subscribe((users) => {
      expect(users).toEqual([]);
      done();
    });
  });

  it('should allow next step', () => {
    const result = UserPanelSelectors.selectNextStepAllowed.projector({
      ...initialState,
      users: [{ id: '1', firstName: 'Jan', last_name: 'Kowalski' } as UserDto],
      userCount: 1,
    });
    expect(result).toBe(true);
  });

  it('should build table data', () => {
    const rows = UserPanelTableQuery.selectTableData.projector([]);
    expect(rows.rows).toEqual([]);
  });

  it('should return the same list for sorted users', () => {
    const users = [{ id: '1', firstName: 'Jan', last_name: 'Kowalski' } as UserDto];
    expect(UserPanelSelectors.selectSortedUsers.projector(users)).toEqual(users);
  });

  it('should build the search summary', () => {
    const users = [{ id: '1', firstName: 'Jan', last_name: 'Kowalski' } as UserDto];
    expect(UserPanelSelectors.selectSearchSummary.projector(users).total).toBe(1);
  });

  it('should build the user table', () => {
    const table = UserPanelSelectors.selectUserTable.projector([]);
    expect(table.displayedColumns).toEqual(['name', 'email', 'status']);
    expect(table.displayedColumnsLabels).toEqual({
      name: 'Full name',
      email: 'E-mail',
      status: 'Status',
    });
  });

  it('should build the header summary', () => {
    const users: UserDto[] = [];
    const table = { columns: ['name'], rows: [] };
    expect(UserPanelSelectors.selectHeaderSummary.projector(users, table).total).toBe(0);
  });
});
