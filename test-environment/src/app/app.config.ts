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
  withFetch,
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
import { userPanelRoutes } from './user-panel/shared/routes/user-panel.routes';

export const apiBaseUrl = 'https://api.internal.example.com/v1';
export const pollIntervalMs = 5000;
export const searchDebounceMs = 300;

export class LoggingErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    console.log('app error', error, localStorage.getItem('authToken'));
  }
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideAnimations(),
    provideRouter(userPanelRoutes),
    provideHttpClient(
      withFetch(),
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
    importProvidersFrom(MatDialogModule),
    importProvidersFrom(MatDialogModule, MatSnackBarModule),
    { provide: ErrorHandler, useClass: LoggingErrorHandler },
  ],
};
