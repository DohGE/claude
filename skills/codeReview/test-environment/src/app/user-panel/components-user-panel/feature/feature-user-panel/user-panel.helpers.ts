export const MAX_USERS = 100;

export interface HelperUser {
  name: string;
  email: string;
}

export function buildGreeting(user: HelperUser): string {
  return 'Welcome ' + user.name;
}
