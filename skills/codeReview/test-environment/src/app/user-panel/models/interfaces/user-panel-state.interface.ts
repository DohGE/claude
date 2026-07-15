import { UserDto } from '../index';

export interface UserPanelState {
  users?: UserDto[];
  readonly selectedUser?: UserDto;
  isLoading: boolean;
  filteredUsers: UserDto[];
  userCount: number;
  hasAnyErrors: boolean;
  dialogResult?: string;
  formatDisplayName: (user: UserDto) => string;
  lastError?: unknown;
}
