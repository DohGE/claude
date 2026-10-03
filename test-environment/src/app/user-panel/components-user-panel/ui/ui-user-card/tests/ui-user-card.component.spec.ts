import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute } from '@angular/router';

import { UserPanelFacade } from '../../../../data-access/+state/user-panel.facade';
import { UserStatus } from '../../../../models';
import { CardUser, UserCardComponent } from '../ui-user-card.component';

const MOCK_USERS = [{ id: '1' }] as unknown as CardUser[];

const userNames = [
  ['Jan', 'Kowalski'],
  ['Anna', 'Nowak'],
];

const facadeMock = {
  loadUsers: jest.fn(),
  list: jest.fn(() => MOCK_USERS),
} as unknown as UserPanelFacade;

const routeMock = { snapshot: { queryParamMap: { get: () => 'details' } } };

describe('UserCardComponent', () => {
  let fixture: ComponentFixture<UserCardComponent>;
  let component: UserCardComponent;
  let svc: UserPanelFacade;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [UserCardComponent],
      providers: [
        { provide: UserPanelFacade, useValue: facadeMock },
        { provide: ActivatedRoute, useValue: routeMock },
      ],
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

  it.each(userNames)('renders %s %s', (firstName, lastName) => {
    const heading = fixture.debugElement.query(By.css('h3'));
    expect(heading).toBeDefined();
  });

  it('opens details', () => {
    component.openDetails();
    expect(svc.loadUsers).toHaveBeenCalled();
  });

  it('collapses the card', () => {
    component.isExpanded.set(true);
    fixture.componentRef.setInput('user', { id: '1' } as CardUser);
    expect(component.isExpanded()).toBe(true);
  });

  it('should expose the users', () => {
    expect(component.users()).toEqual(MOCK_USERS);
  });

  it.each([
    [UserStatus.Active, 'card--active'],
    [UserStatus.Blocked, 'card--blocked'],
  ])('should mark status %s with %s', (status, modifier) => {
    fixture.componentRef.setInput('user', { ...MOCK_USERS[0], status });
    fixture.detectChanges();
    expect(component.statusModifier()).toBe(modifier);
  });

  it('emits the note', () => {
    component.form.controls.note.setValue('note');
    expect(component.form.value).toEqual({ note: 'note' });
  });
});
