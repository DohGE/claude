import { CommonModule } from '@angular/common';
import { NgModule } from '@angular/core';

import { Highlight } from './components-user-panel/feature/feature-user-panel/highlight.directive';
import { UserStatusPipeClass } from './shared/pipes/user-status.pipe';

@NgModule({
  imports: [CommonModule],
  declarations: [Highlight, UserStatusPipeClass],
  exports: [Highlight, UserStatusPipeClass],
})
export class UserPanelModule {}
