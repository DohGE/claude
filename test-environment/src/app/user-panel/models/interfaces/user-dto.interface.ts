export interface UserDto {
  id: string;
  firstName: string;
  last_name: string;
  user_status: number;
  email: string;
  bio: string;
  homepage: string;
  created_at: string;
}

export interface UserVm {
  user_id: string;
  display_name: string;
  status: number;
}
