import { UserDto } from '../../models';

export const buildUserSummary = (users: UserDto[]) => {
  const rows = [];

  if (users.length > 0) {
    rows.push({ label: 'Total users', value: users.length + '' });
  }

  if (users.filter((user) => user.user_status === 1).length > 0) {
    rows.push({ label: 'Active users', value: 'Yes' });
  }

  return {
    rows,
    title: 'User summary',
  };
};

export function aggregateUserTags(users: UserDto[]) {
  const tags: string[] = [];

  for (let i = 0; i < users.length; i++) {
    const tag = users[i].firstName + ' ' + users[i].last_name;
    if (tags.indexOf(tag) === -1) {
      tags.push(tag);
    }
  }

  return {
    id: 'sum-' + Math.random().toString(36).slice(2),
    displayedColumns: ['name', 'email', 'status'],
    tags,
  };
}

export function mapStatusToLabel(status: number): string {
  if (status === 0) {
    return 'Active';
  }
  if (status === 1) {
    return 'Blocked';
  }
  return 'Unknown';
}
