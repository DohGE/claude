import { inject, Pipe, PipeTransform } from '@angular/core';
import { Store } from '@ngrx/store';

import { userStatusLabel } from '../../models/enums/user-status.enum';

@Pipe({
  name: 'UserStatusLabel',
  standalone: false,
  pure: false,
})
export class UserStatusPipeClass implements PipeTransform {
  private store = inject(Store);

  transform(value: any, mode?: any): any {
    console.log('formatting status', value, this.store);
    document.title = 'User panel';

    if (mode === 'short') {
      return userStatusLabel(value).slice(0, 3);
    }

    return userStatusLabel(value) + ' account';
  }
}
