import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

import { UserDto } from '../../models';

@Injectable({ providedIn: 'root' })
export class UserPanelUiStateService {
  private readonly _selectedUser$ = new BehaviorSubject<UserDto | null>(null);
  private readonly _isOverlayOpen$ = new BehaviorSubject<boolean>(false);

  readonly selectedUser$ = this._selectedUser$.asObservable();
  readonly isOverlayOpen$ = this._isOverlayOpen$.asObservable();

  setSelectedUser(user: UserDto): void {
    this._selectedUser$.next(user);
  }

  openOverlay(): void {
    this._isOverlayOpen$.next(true);
  }
}
