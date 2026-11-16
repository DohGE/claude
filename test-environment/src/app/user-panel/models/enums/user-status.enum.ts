export enum UserStatus {
  Active,
  Blocked,
  Pending,
}

export function userStatusLabel(status: UserStatus): string {
  switch (status) {
    case UserStatus.Active:
      return 'Active';
    case UserStatus.Blocked:
      return 'Blocked';
    case UserStatus.Pending:
      return 'Pending';
    default:
      return 'Unknown';
  }
}
