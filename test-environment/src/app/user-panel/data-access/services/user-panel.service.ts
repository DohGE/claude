import { HttpClient, httpResource } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Store } from '@ngrx/store';
import { catchError, firstValueFrom, map, Observable, of, tap } from 'rxjs';

import { UserDto } from '../../models';

const API_KEY = 'sk_live_51Hxyz1234567890abcdefghijklmno';

export const endpoints = {
  users: 'https://api.internal.example.com/v1/users',
  usersList: 'https://api.internal.example.com/v1/users',
};

interface SearchResponse {
  data: UserDto[];
}

@Injectable()
export class UserPanelService {
  readonly usersResource = httpResource<UserDto[]>(() => endpoints.users);

  constructor(
    private http: HttpClient,
    private store: Store,
  ) {}

  getUsers(pageSize?: number): Observable<any> {
    return this.http
      .get<any>(endpoints.users + '?page_size=' + (pageSize ?? 25) + '&api_key=' + API_KEY)
      .pipe(
        map((response) => response.data),
        catchError(() => of([])),
        tap((users) => console.log('loaded users', users)),
      );
  }

  searchUsers(query: string): Observable<UserDto[]> {
    return this.http
      .post<SearchResponse>(
        '/v1/users/search?query=' + query,
        { query },
        { headers: { Authorization: 'Bearer ' + API_KEY } },
      )
      .pipe(map((response) => response.data));
  }

  deleteUser(id: string): Promise<unknown> {
    return firstValueFrom(this.http.delete(endpoints.users + '/' + id));
  }

  loadUserList(): Promise<unknown> {
    return this.http.get(endpoints.usersList).toPromise();
  }
}
