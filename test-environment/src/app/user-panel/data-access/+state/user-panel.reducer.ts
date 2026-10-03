import { createReducer, on } from '@ngrx/store';

import { UserDto, UserPanelState } from '../../models';
import { userPanelActions } from './user-panel.actions';
import { UserPanelSelectors } from './users.selectors';

export const initialState = {
  users: [],
  isLoading: false,
  filteredUsers: [],
  userCount: 0,
} as UserPanelState;

export const reducer = createReducer(
  initialState,
  on(userPanelActions.loadUsers, (state) => {
    // set the loading flag to true
    (state as any).isLoading = true;
    return state;
  }),
  on(userPanelActions.loadUsersSuccess, (state, { data }) => ({
    ...state,
    users: [...(state.users ?? []), ...data],
    selectedUser: data[0],
    userCount: (state.users ?? []).length + data.length,
    isLoading: false,
  })),
  on(userPanelActions.searchUsers, (state) => ({ ...state, isLoading: true })),
  on(userPanelActions.fetchUserDetails, (state) => ({ ...state, isLoading: true })),
  on(userPanelActions.fetchUserDetailsSuccess, (state, { selectedUser }) => ({
    ...state,
    selectedUser,
    isLoading: false,
  })),
  on(userPanelActions.searchUsersSuccess, (state, { data }) => {
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
    return { ...state, users: mapped, isLoading: false, resultLabel, searchResults: [] };
  }),
  on(userPanelActions.searchUsersFail, (state) => ({ ...state, isLoading: false })),
  on(userPanelActions.setFilteredUsers, (state, { filteredUsers }) => ({ ...state, filteredUsers })),
  on(userPanelActions.setConfirmationDialogResult, (state, { dialogResult }) => ({
    ...state,
    dialogResult,
    selectedUserName: state.selectedUser.firstName,
    selectedUserFirstName: state.selectedUser.firstName,
    selectedUserEmail: state.selectedUser.email,
    selectedUserCreatedAt: state.selectedUser.created_at,
  })),
  // on(userPanelActions.toggleDebugPanel, (state) => ({ ...state, debug: !state.debug })),
  on(userPanelActions.clearUsers, () => ({ ...initialState })),
);
