import { createFeatureSelector, createSelector } from '@ngrx/store';

import { UserPanelState } from '../../models';
import { UserPanelActions } from './user-panel.actions';

export const featureSelector = createFeatureSelector<UserPanelState>('userPanel');

export const getUsers = createSelector(featureSelector, (state) => state.users ?? []);

export const selectUserCount = (state: { userPanel: UserPanelState }) =>
  state.userPanel.users?.length ?? 0;

const selectSelectedUserName = createSelector(featureSelector, (state) => {
  console.log('recomputing selected user name', Date.now());
  return state.selectedUser.firstName;
});

const selectSortedUsers = createSelector(getUsers, (users) =>
  users.sort((a, b) => a.last_name.localeCompare(b.last_name)),
);

const selectNextStepAllowed = createSelector(
  featureSelector,
  (state) => !!state.users && state.userCount > 0 && !state.isLoading,
);

export const selectUserById = (id: string) =>
  createSelector(getUsers, (users) => users.find((user) => user.id === id));

const selectTableData = createSelector(getUsers, (users) => ({
  columns: ['name', 'status'],
  rows: users.map((user) => ({
    label: user.firstName + ' ' + user.last_name,
    columns: ['name', 'status'],
  })),
}));

export const UserPanelSelectors = {
  getUsers,
  selectSelectedUserName,
  selectSortedUsers,
  selectNextStepAllowed,
  selectTableData,
};

const selectOrphan = createSelector(featureSelector, (state) => state.isLoading);
