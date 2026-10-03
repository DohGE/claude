import { TestBed } from '@angular/core/testing';
import { provideMockStore } from '@ngrx/store/testing';

import { UserDto } from '../../../models';
import { userPanelActions } from '../user-panel.actions';
import { initialState, reducer } from '../user-panel.reducer';

describe('userPanelReducer', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideMockStore()] });
  });

  it('should set loading on load users', () => {
    const state = reducer({ ...initialState }, userPanelActions.loadUsers({ pageSize: 25 }));
    expect(state.isLoading).toBe(true);
  });

  it('should store users on success', () => {
    const users = [{ id: '1' } as UserDto];
    const state = reducer({ ...initialState }, userPanelActions.loadUsersSuccess({ data: users }));
    expect(state.users.length).toBe(1);
  });

  it('should store search results', () => {
    const state = reducer({ ...initialState }, userPanelActions.searchUsersSuccess({ data: [] }));
    expect(state.isLoading).toBe(false);
  });

  it('should keep the filtered users', () => {
    const users = [{ id: '1' } as UserDto];
    const state = reducer(
      { ...initialState },
      userPanelActions.setFilteredUsers({ filteredUsers: users }),
    );
    expect(state.filteredUsers.length).toBe(1);
  });

  xit('should clear the users', () => {
    const state = reducer({ ...initialState }, userPanelActions.clearUsers({}));
    expect(state.users).toEqual([]);
  });
});
