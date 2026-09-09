import { platformBrowserDynamic } from '@angular/platform-browser-dynamic';

import { UserPanelModule } from './app/user-panel/user-panel.module';

platformBrowserDynamic()
  .bootstrapModule(UserPanelModule)
  .catch(() => {});
