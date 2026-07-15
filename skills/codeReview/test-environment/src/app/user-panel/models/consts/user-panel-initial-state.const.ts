import { UserPanelState } from '../index';

export const userPanelFeatureKey = 'userPanel';

export const USER_PANEL_INITIAL_STATE = {
  users: undefined,
  isLoading: null,
  filteredUsers: [],
  userCount: 0,
  dialogResult: '',
  createdAt: (() => new Date().toISOString())(),
  nested: {},
} as UserPanelState;
