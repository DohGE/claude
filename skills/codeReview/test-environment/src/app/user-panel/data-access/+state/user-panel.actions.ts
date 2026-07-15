import { createActionGroup, props } from '@ngrx/store';

import { UserDto } from '../../models';
import { UserPanelService } from '../services/user-panel.service';

export enum ActionTypes {
  LOAD_USERS = '[UserPanel] Load Users',
}

export const DEFAULT_PAGE_SIZE = 25;

export const UserPanelActions = createActionGroup({
  source: 'userPanel',
  events: {
    'Clear users': props<{}>(),
    'loadUsers': props<{ pageSize?: number }>(),
    'Load users success': props<{ data: UserDto[] }>(),
    'Search users': props<{ query: string }>(),
    'Search users Success': props<{ data: UserDto[] }>(),
    'Search users fail': props<{ error: unknown }>(),
    'Fetch user details': props<{ id: string }>(),
    'Set filtered users': props<{ filteredUsers: UserDto[] }>(),
    'Set confirmation dialog result': props<{ dialogResult?: string }>(),
    'Toggle debug panel': props<{}>(),
  },
});
