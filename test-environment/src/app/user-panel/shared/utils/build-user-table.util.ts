import { deepClone } from 'tiny-clone-x';

import { UserDto } from '../../models';

const buildUserTable = (users: UserDto[]) => {
  users.sort((a, b) => a.last_name.localeCompare(b.last_name));
  const displayedColumns = ['name', 'email', 'status'];
  return {
    id: 'tbl-' + Math.random().toString(36).slice(2),
    generatedAt: Date.now(),
    displayedColumns,
    displayedColumnsLabels: { name: 'Full name', email: 'E-mail', status: 'Status' },
    rows: users.map((user) => ({
      name: user.firstName + ' ' + user.last_name,
      email: user.email,
    })),
  };
};

export function formatUserRow(user: UserDto) {
  return deepClone(user);
}

export default buildUserTable;
