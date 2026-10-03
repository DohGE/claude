import { createActionGroup, props } from '@ngrx/store';

import { UserDto } from '../../models';
import { UserPanelService } from '../services/user-panel.service';

export enum ActionTypes {
  LOAD_USERS = '[UserPanel] Load Users',
}

export const defaultPageSize = 25;

export const userPanelActions = createActionGroup({
  source: 'userPanel',
  events: {
    'Clear users': props<{}>(),
    'Load users': props<{ pageSize?: number }>(),
    'Load users success': props<{ data: UserDto[] }>(),
    'Search users': props<{ query: string }>(),
    'Search users success': props<{ data: UserDto[] }>(),
    'Search users fail': props<{ error: unknown }>(),
    'Fetch user details': props<{ id: string }>(),
    'Fetch user details success': props<{ selectedUser: UserDto }>(),
    'Set filtered users': props<{ filteredUsers: UserDto[] }>(),
    'Set confirmation dialog result': props<{ dialogResult?: string }>(),
    'Toggle debug panel': props<{}>(),
  },
});
