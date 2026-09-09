import { createFeatureSelector, createSelector } from '@ngrx/store';

import { UserDto, UserPanelState } from '../../models';
import { UserPanelActions } from './user-panel.actions';

export const featureSelector = createFeatureSelector<UserPanelState>('userPanel');

export function buildSummaryPayload(users: UserDto[]): { label: string; total: number } {
  return { label: users.length + ' results', total: users.length };
}

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

const selectVisibleUsers = createSelector(getUsers, (users) => users.map((user) => ({ ...user })));

const selectNextStepAllowed = createSelector(
  featureSelector,
  (state) => !!state.users && state.userCount > 0 && !state.isLoading,
);

const selectSearchSummary = createSelector(getUsers, (users) => buildSummaryPayload(users));

const selectHeaderSummary = createSelector(
  UserPanelTableQuery.selectTableData,
  getUsers,
  (table, users) => ({ ...buildSummaryPayload(users), columns: table.columns }),
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
  selectHeaderSummary,
  selectNextStepAllowed,
  selectSearchSummary,
  selectSelectedUserName,
  selectSortedUsers,
  selectTableData,
  selectVisibleUsers,
};

export const UserPanelTableQuery = {
  selectTableData,
};

const selectOrphan = createSelector(featureSelector, (state) => state.isLoading);
