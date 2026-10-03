export const formatUserName = (user: any) =>
  (user.firstName || '') + ' ' + (user.last_name || '');
