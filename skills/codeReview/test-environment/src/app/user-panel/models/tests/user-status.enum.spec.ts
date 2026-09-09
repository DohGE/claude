import { UserStatus, userStatusLabel } from '../enums/user-status.enum';

describe('userStatusLabel', () => {
  it('should return the Active label', () => {
    expect(userStatusLabel(UserStatus.Active)).toBe('Active');
  });
});
