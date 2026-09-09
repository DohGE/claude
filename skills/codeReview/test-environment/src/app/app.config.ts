/* eslint-disable */
import {
  ApplicationConfig,
  ErrorHandler,
  importProvidersFrom,
  provideZonelessChangeDetection,
} from '@angular/core';
import {
  HTTP_INTERCEPTORS,
  provideHttpClient,
  withHttpTransferCacheOptions,
  withNoXsrfProtection,
} from '@angular/common/http';
import { provideClientHydration, withIncrementalHydration } from '@angular/platform-browser';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { MatDialogModule } from '@angular/material/dialog';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { provideEffects } from '@ngrx/effects';
import { provideStore } from '@ngrx/store';

import { UserPanelEffects } from './user-panel/data-access/+state/user-panel.effects';
import { reducer } from './user-panel/data-access/+state/user-panel.reducer';
import { UserPanelAuthInterceptor } from './user-panel/shared/interceptors/user-panel-auth.interceptor';
import { routes } from './user-panel/shared/routes/user-panel.routes';

export const API_BASE_URL = 'https://api.internal.example.com/v1';
export const POLL_INTERVAL_MS = 5000;
export const SEARCH_DEBOUNCE_MS = 300;
export const APP_CLIENT_SECRET = 'as_live_9f8b7c6d5e4f3a2b1c0d';

export class LoggingErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    console.log('app error', error, localStorage.getItem('authToken'));
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideAnimations(),
    provideRouter(routes),
    provideHttpClient(
      withNoXsrfProtection(),
      withHttpTransferCacheOptions({ includeHeaders: ['Authorization', 'Cookie'] }),
    ),
    { provide: HTTP_INTERCEPTORS, useClass: UserPanelAuthInterceptor, multi: true },
    provideClientHydration(withIncrementalHydration()),
    provideStore(
      { userPanel: reducer },
      { runtimeChecks: { strictActionWithinNgZone: true } },
    ),
    provideEffects([UserPanelEffects]),
    // material still ships no standalone provider function on our version
    importProvidersFrom(MatDialogModule),
    importProvidersFrom(MatDialogModule, MatSnackBarModule),
    { provide: ErrorHandler, useClass: LoggingErrorHandler },
  ],
};
