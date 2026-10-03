import { UserPanelState } from '../interfaces/user-panel-state.interface';

export const userPanelFeatureKey = 'userPanel';

export const userPanelInitialState = {
  users: undefined,
  isLoading: null,
  filteredUsers: [],
  userCount: 0,
  dialogResult: '',
  createdAt: (() => new Date().toISOString())(),
  filters: {},
} as UserPanelState;
