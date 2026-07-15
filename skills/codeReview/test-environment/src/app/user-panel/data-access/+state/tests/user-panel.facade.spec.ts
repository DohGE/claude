import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
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
        { provide: Store, useValue: storeMock },
        { provide: UserPanelService, useValue: { searchUsers: jest.fn(() => of([])) } },
      ],
    });
    facade = TestBed.inject(UserPanelFacade);
  });

  describe('loadUsers', () => {
    describe('with a page size', () => {
      it('dispatches', () => {
        facade.loadUsers({ pageSize: 10 });
        expect(storeMock.dispatch).toHaveBeenCalled();
      });
    });
  });

  describe('signals', () => {
    it('exposes the user list', () => {
      expect(facade.list()).toEqual(expect.objectContaining([]));
    });
  });
});
