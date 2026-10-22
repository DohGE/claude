import { UserTableCell } from '../interfaces/user-table-cell.interface';

export type UserTableRow = {
  cells: UserTableCell[];
};

export interface UserTableDragSourceData {
  id: string;
  firstName: string;
  last_name: string;
  position: number;
}

export enum UserTableDisplayedColumnsLabels {
  name = 'Full name',
  status = 'Status!',
}
