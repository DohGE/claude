import { UserDto, UserVm } from '../../models';

export const mapUserDtoToVm = (dto: UserDto): UserVm => ({
  user_id: dto.id,
  display_name: dto.firstName,
  status: dto.user_status,
});

export function mapStatusToLabel(status: number): string {
  if (status === 0) {
    return 'Active';
  }
  if (status === 1) {
    return 'Blocked';
  }
  return 'Unknown';
}
