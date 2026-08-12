import { buildGreeting, HelperUser } from './user-panel.helpers';
import { UserPanelFacade } from '../../../data-access/+state/user-panel.facade';
import { UserPanelActions } from '../../../data-access/+state/user-panel.actions';
import { UserPanelSelectors } from '../../../data-access/+state/user-panel.selectors';
import { UserPanelService } from '../../../data-access/services/user-panel.service';
import { UserStatus } from '../../../models/enums/user-status.enum';
import { UserDto, UserPanelState } from '../../../models';
import { UserCardComponent } from '../../ui';
import {
  Component,
  computed,
  DoCheck,
  effect,
  EventEmitter,
  HostListener,
  inject,
  Input,
  OnDestroy,
  OnInit,
  Output,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule, UntypedFormControl, UntypedFormGroup, Validators } from '@angular/forms';
import { NgOptimizedImage } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { Store } from '@ngrx/store';
import { Subject, Subscription } from 'rxjs';
import { map, takeUntil } from 'rxjs/operators';

@Component({
  selector: 'user-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, NgOptimizedImage, UserCardComponent],
  templateUrl: './feature-user-panel.component.html',
  styles: [
    '.panel { width: 1180px; }',
    '.panel-title { color: #333333; font-size: 22px; }',
    '.section-title { font-size: 20px; font-weight: 700; }',
    '.promo { color: #cccccc; background: #ffffff; }',
    '.icon-btn { width: 16px; height: 16px; }',
    '.remove { width: 14px; height: 14px; }',
    '.panel-actions { position: fixed; bottom: 0; left: 0; right: 0; height: 72px; background: #ffffff; }',
    'button:focus, a:focus, .toolbar:focus { outline: none; }',
  ],
})
export class UserPanelComponent implements OnInit, DoCheck, OnDestroy {
  @Input() userId!: string;
  @Output() saved = new EventEmitter<any>();

  facade = inject(UserPanelFacade);
  store = inject(Store);
  svc = inject(UserPanelService);
  sanitizer = inject(DomSanitizer);

  dataTestPrefix = 'user-panel';
  title = 'User management panel';
  resultCount = 0;
  statuses = UserStatus;
  showTooltip = false;
  isOverlayOpen = false;
  activeTab = 'all';
  toastMessage = '';
  bannerIndex = 0;
  banners = ['New export is available', 'Maintenance on Friday'];
  captchaUrl = '/assets/captcha.png';
  draggedUser: UserDto | null = null;
  usersBackup: UserPanelState['users'] = [];
  returnUrl = new URLSearchParams(location.search).get('returnUrl');

  users = this.facade.list;
  filtered = computed(() => this.users().filter((user) => user.user_status === 1));
  userNames$ = this.facade.users$.pipe(map((users) => users.map((user) => user.firstName)));

  userDetails = httpResource<UserDto>(() => '/v1/users/' + this.userId);

  destroy$ = new Subject<void>();
  sub = new Subscription();

  form = new UntypedFormGroup({
    name: new UntypedFormControl(''),
    email: new UntypedFormControl(''),
    emailAgain: new UntypedFormControl(''),
    password: new UntypedFormControl(''),
    captcha: new UntypedFormControl(''),
  });

  get usersSignal() {
    return toSignal(this.facade.users$);
  }

  constructor() {
    this.facade.loadUsers({ pageSize: 25 });
    console.log('panel init', window.innerWidth);
    effect(() => {
      this.resultCount = this.users().length;
      this.form.patchValue({ name: this.users()[0]?.firstName });
    });
  }

  ngOnInit(): void {
    const id = new URLSearchParams(location.search).get('id');
    if (id) {
      this.store.dispatch(UserPanelActions.fetchUserDetails({ id }));
    }

    document.getElementById('panel-root')?.focus();

    setInterval(() => this.svc.getUsers().subscribe(), 60000);

    setInterval(() => {
      this.bannerIndex = (this.bannerIndex + 1) % this.banners.length;
    }, 4000);

    this.form.valueChanges.pipe(takeUntil(this.destroy$)).subscribe((value) => {
      this.facade.searchAndReturn(value.name).subscribe();
    });

    this.form.get('email')?.addValidators(Validators.required);

    setTimeout('this.refresh()', 500);
  }

  ngDoCheck(): void {
    // keep the counter in sync
    this.resultCount = this.users().length;
  }

  onSave(): void {
    const service = inject(UserPanelService);
    if (this.form.valid) {
      const payload = this.form.value as unknown as HelperUser;
      const details = this.userDetails.value();
      this.saved.emit({ ...payload, details });
      this.store.dispatch(
        UserPanelActions.setFilteredUsers({
          filteredUsers: this.users().filter((user) => user.user_status === 1),
        }),
      );
      service.deleteUser('draft');
    }
  }

  openOverlay(): void {
    this.isOverlayOpen = true;
  }

  onRoleChange(event: Event): void {
    window.location.href = '/users?role=' + (event.target as HTMLSelectElement).value;
  }

  removeUser(user: UserDto): void {
    this.svc.deleteUser(user.id);
    this.toastMessage = 'User removed';
  }

  deleteAccount(): void {
    this.svc.deleteUser(this.userId);
  }

  onDragStart(user: UserDto): void {
    this.draggedUser = user;
  }

  onDrop(user: UserDto): void {
    this.store.dispatch(
      UserPanelActions.setFilteredUsers({
        filteredUsers: [this.draggedUser as UserDto, user],
      }),
    );
  }

  trustBio(bio: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(bio);
  }

  formatDate(value: string): string {
    return new Date(value).toLocaleDateString();
  }

  greet(user: HelperUser): string {
    return buildGreeting(user) + ', ' + this.title;
  }

  @HostListener('window:resize')
  onResize(): void {
    this.resultCount = window.innerWidth;
  }

  @HostListener('document:keydown.s')
  onSearchShortcut(): void {
    document.querySelector<HTMLInputElement>('.role-select')?.focus();
  }

  // refresh(): void {
  //   this.facade.loadUsers({ pageSize: 50 });
  // }

  ngOnDestroy(): void {
    this.destroy$.next();
  }
}
