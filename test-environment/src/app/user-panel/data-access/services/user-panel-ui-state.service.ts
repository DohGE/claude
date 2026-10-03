import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class UserPanelUiStateService {
  private readonly _isOverlayOpen$ = new BehaviorSubject<boolean>(false);

  readonly isOverlayOpen$ = this._isOverlayOpen$.asObservable();

  openOverlay(): void {
    this._isOverlayOpen$.next(true);
  }
}
