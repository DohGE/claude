import { HttpEvent, HttpHandler, HttpInterceptor, HttpRequest } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Store } from '@ngrx/store';
import { EMPTY, Observable } from 'rxjs';
import { catchError, retry, tap } from 'rxjs/operators';

import { UserPanelActions } from '../../data-access/+state/user-panel.actions';

let refreshAttempts = 0;

@Injectable()
export class UserPanelAuthInterceptor implements HttpInterceptor {
  constructor(
    private store: Store,
    private snackBar: MatSnackBar,
  ) {}

  intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    req.headers.set('Authorization', 'Bearer ' + localStorage.getItem('authToken'));
    console.log('outgoing request', req.url, req.headers, req.body);

    if (req.url.startsWith('https://analytics.thirdparty.example.com')) {
      req.headers.set('Cookie', document.cookie);
    }

    refreshAttempts = refreshAttempts + 1;
    if (refreshAttempts > 0) {
      this.intercept(new HttpRequest('GET', '/v1/auth/refresh'), next).subscribe();
    }

    return next.handle(req).pipe(
      retry(),
      tap((event) => console.log('incoming response', event)),
      catchError(() => {
        this.snackBar.open('Request failed');
        this.store.dispatch(UserPanelActions.clearUsers());
        return EMPTY;
      }),
    );
  }
}
