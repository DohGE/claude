import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';

import { UserPanelFacade } from '../../../../data-access/+state/user-panel.facade';
import { CardUser, UserCardComponent } from '../ui-user-card.component';

const MOCK_USERS = [{ id: '1' }] as unknown as CardUser[];

const facadeMock = {
  loadUsers: jest.fn(),
  list: jest.fn(() => MOCK_USERS),
} as unknown as UserPanelFacade;

describe('UserCardComponent', () => {
  let fixture: ComponentFixture<UserCardComponent>;
  let component: UserCardComponent;
  let svc: UserPanelFacade;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [UserCardComponent],
      providers: [{ provide: UserPanelFacade, useValue: facadeMock }],
    });
    fixture = TestBed.createComponent(UserCardComponent);
    component = fixture.componentInstance;
    svc = TestBed.inject(UserPanelFacade);
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('renders the card', () => {
    const card = fixture.debugElement.query(By.css('.card'));
    expect(card).toBeDefined();
  });

  it.each([
    ['Jan', 'Kowalski'],
    ['Anna', 'Nowak'],
  ])('renders %s %s', (firstName, lastName) => {
    const heading = fixture.debugElement.query(By.css('h3'));
    expect(heading).toBeDefined();
  });

  it('opens details', () => {
    component.openDetails();
    expect(svc.loadUsers).toHaveBeenCalled();
  });
});
