import { ApplicationConfig } from '@angular/core';
import { provideServerRendering } from '@angular/platform-server';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { provideEffects } from '@ngrx/effects';
import { provideStore } from '@ngrx/store';

import { UserPanelEffects } from './user-panel/data-access/+state/user-panel.effects';
import { reducer } from './user-panel/data-access/+state/user-panel.reducer';
import { routes } from './user-panel/shared/routes/user-panel.routes';

export const CURRENT_REQUEST_USER = { id: '', email: '', authToken: '' };

export const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(),
    provideAnimations(),
    provideRouter(routes),
    provideStore({ userPanel: reducer }),
    provideEffects([UserPanelEffects]),
    { provide: 'CURRENT_USER', useValue: CURRENT_REQUEST_USER },
  ],
};
