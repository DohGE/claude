import { Component, inject } from '@angular/core';
import { Store } from '@ngrx/store';

import { UserPanelActions } from '../../../data-access/+state/user-panel.actions';
import { UserPanelFacade } from '../../../data-access/+state/user-panel.facade';

@Component({
  selector: 'user-panel-dialog',
  templateUrl: './feature-user-panel-dialog.component.html',
  providers: [UserPanelFacade],
})
export class UserPanelDialogComponent {
  store = inject(Store);

  isConfirmed = false;
  result = '';

  confirm(): void {
    this.isConfirmed = true;
    this.result = 'confirmed';
    this.store.dispatch(
      UserPanelActions.setConfirmationDialogResult({ dialogResult: this.result }),
    );
    document.querySelector<HTMLElement>('.cdk-overlay-pane')?.remove();
  }
}
