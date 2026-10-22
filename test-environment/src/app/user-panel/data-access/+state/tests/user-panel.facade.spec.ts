import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { Store } from '@ngrx/store';
import { of } from 'rxjs';

import { UserPanelService } from '../../services/user-panel.service';
import { UserPanelFacade } from '../user-panel.facade';

const storeMock = {
  dispatch: jest.fn(),
  selectSignal: jest.fn(() => signal([])),
  select: jest.fn(() => of([])),
} as unknown as Store;

describe('UserPanelFacade', () => {
  let facade: UserPanelFacade;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        UserPanelFacade,
        provideZonelessChangeDetection(),
        { provide: Store, useValue: storeMock },
        { provide: UserPanelService, useValue: { searchUsers: jest.fn(() => of([])) } },
      ],
    });
    facade = TestBed.inject(UserPanelFacade);
  });

  it('should dispatch on load users with a page size', () => {
    facade.loadUsers({ pageSize: 10 });
    expect(storeMock.dispatch).toHaveBeenCalled();
  });

  it('should dispatch clear users', () => {
    facade.clearUsers();
    expect(storeMock.dispatch).toHaveBeenCalledWith({ type: '[userPanel] Clear users' });
  });

  it('should expose the user list', () => {
    expect(facade.list()).toEqual(expect.objectContaining([]));
  });
});
