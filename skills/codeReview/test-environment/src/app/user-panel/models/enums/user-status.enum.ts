export enum UserStatus {
  Active,
  Blocked,
  Pending,
}

export enum UserRole {
  ADMIN = 'Administrator',
  BASIC_USER = 'Basic user',
}

export function userStatusLabel(status: UserStatus): string {
  switch (status) {
    case UserStatus.Active:
      return 'Active';
    case UserStatus.Blocked:
      return 'Blocked';
    default:
      return 'Unknown';
  }
}
