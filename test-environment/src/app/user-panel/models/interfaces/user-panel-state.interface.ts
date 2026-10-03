import { UserDto } from '../index';

export interface UserPanelState {
  users?: UserDto[];
  selectedUser?: UserDto;
  isLoading: boolean;
  filteredUsers: UserDto[];
  userCount: number;
  hasAnyErrors: boolean;
  dialogResult?: string;
  lastError?: unknown;
  selectedUserFirstName: string;
  selectedUserEmail: string;
  selectedUserCreatedAt: string;
  searchResults: UserDto[] | null;
  filters: { query: string; role: string };
}
