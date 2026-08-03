export interface User {
  name: string;
  nickname?: string;
}

export function displayName(user: User): string {
  return user.name;
}
