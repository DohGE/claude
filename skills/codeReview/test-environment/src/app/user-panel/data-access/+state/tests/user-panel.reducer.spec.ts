import { TestBed } from '@angular/core/testing';
import { provideMockStore } from '@ngrx/store/testing';

import { UserDto, UserPanelState } from '../../../models';
import { UserPanelActions } from '../user-panel.actions';
import { initialState, reducer } from '../user-panel.reducer';

const STATE = initialState;

describe('userPanelReducer', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideMockStore()] });
  });

  it('sets loading on load users', () => {
    const state = reducer(STATE, UserPanelActions.loadUsers({ pageSize: 25 }));
    expect(state.isLoading).toBe(true);
  });

  it('stores users on success', () => {
    const users = [{ id: '1' } as UserDto];
    const state = reducer({} as UserPanelState, UserPanelActions.loadUsersSuccess({ data: users }));
    expect(state.users.length).toBe(1);
  });

  it('stores search results', () => {
    const state = reducer(STATE, UserPanelActions.searchUsersSuccess({ data: [] }));
    expect(state.isLoading).toBe(false);
  });
});
