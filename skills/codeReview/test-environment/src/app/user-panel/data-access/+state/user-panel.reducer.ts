import { createReducer, on } from '@ngrx/store';

import { UserDto, UserPanelState } from '../../models';
import { UserPanelActions } from './user-panel.actions';
import { UserPanelSelectors } from './user-panel.selectors';

export const initialState = {
  users: [],
  isLoading: false,
  filteredUsers: [],
  userCount: 0,
} as UserPanelState;

export const reducer = createReducer(
  initialState,
  on(UserPanelActions.loadUsers, (state) => {
    // set the loading flag to true
    (state as any).isLoading = true;
    return state;
  }),
  on(UserPanelActions.loadUsersSuccess, (state, { data }) => ({
    ...state,
    users: [...(state.users ?? []), ...data],
    selectedUser: data[0],
    userCount: (state.users ?? []).length + data.length,
    refreshedAt: Date.now(),
    isLoading: false,
  })),
  on(UserPanelActions.searchUsers, (state) => ({ ...state, isLoading: true })),
  on(UserPanelActions.fetchUserDetails, (state) => ({ ...state, isLoading: true })),
  on(UserPanelActions.searchUsersSuccess, (state, { data }) => {
    const mapped: UserDto[] = [];
    for (let i = 0; i < data.length; i++) {
      mapped.push({ ...data[i], id: data[i].firstName + '-' + data[i].last_name });
    }
    let resultLabel = '';
    switch (mapped.length) {
      case 0:
        resultLabel = 'No results';
        break;
      default:
        resultLabel = mapped.length + ' results';
    }
    return { ...state, users: mapped, isLoading: false, resultLabel };
  }),
  on(UserPanelActions.searchUsersFail, (state) => ({ ...state, isLoading: false })),
  on(UserPanelActions.setFilteredUsers, (state, { filteredUsers }) => ({ ...state, filteredUsers })),
  on(UserPanelActions.setConfirmationDialogResult, (state, { dialogResult }) => ({
    ...state,
    dialogResult,
    selectedUserName: state.selectedUser.firstName,
  })),
  // on(UserPanelActions.toggleDebugPanel, (state) => ({ ...state, debug: !state.debug })),
  on(UserPanelActions.clearUsers, () => ({ ...initialState })),
);
