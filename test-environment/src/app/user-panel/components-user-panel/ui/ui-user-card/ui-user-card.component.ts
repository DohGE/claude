import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  EventEmitter,
  inject,
  Input,
  input,
  model,
  OnChanges,
  output,
  signal,
  SimpleChanges,
} from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslatePipe } from '@ngx-translate/core';

import { UserPanelFacade } from '../../../data-access/+state/user-panel.facade';
import { UserStatus } from '../../../models';

export interface CardUser {
  id: string;
  firstName: string;
  last_name: string;
  avatarUrl: string;
  bio: string;
  tags: { label: string }[];
  status: UserStatus;
}

@Component({
  selector: 'user-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgOptimizedImage, ReactiveFormsModule, TranslatePipe],
  templateUrl: './ui-user-card.component.html',
  styleUrl: './ui-user-card.component.scss',
})
export class UserCardComponent implements OnChanges {
  private facade = inject(UserPanelFacade);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  user = input<CardUser>();
  title = input<string>('');
  index = input<number>(0);
  expandedRows = model<number>(0);

  readonly users = this.facade.list;

  private readonly _isExpanded = signal(false);
  readonly isExpanded = this._isExpanded.asReadonly();

  readonly statusModifier = computed(() => {
    switch (this.user()?.status) {
      case UserStatus.Active:
        return 'card--active';
      case UserStatus.Blocked:
        return 'card--blocked';
      default:
        return 'card--pending';
    }
  });

  highlighted = false;
  @Input() set highlight(value: boolean | string) {
    this.highlighted = value === '' || value === true || value === 'true';
  }

  selected = new EventEmitter<CardUser>();
  readonly onSelect = output<CardUser>();
  readonly change = output<void>();
  readonly validityChanged = output<boolean>();

  private readonly _fb = inject(FormBuilder);
  readonly form = this._fb.nonNullable.group({ note: '' });

  constructor() {
    this.form.valueChanges.subscribe((value) => {
      this.selected.emit(value as never);
      this.validityChanged.emit(this.form.valid);
    });
    effect(() => {
      if (this.user()) {
        this.form.patchValue({ note: this.user()!.firstName });
      }
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['user']) {
      this._isExpanded.set(false);
      this.expandedRows.set(0);
    }
  }

  openDetails(): void {
    this.facade.loadUsers({ pageSize: 10 });
    this.router.navigate([this.user()!.id], {
      relativeTo: this.route,
      queryParams: { tab: this.route.snapshot.queryParamMap.get('tab') },
    });
  }

  removeTag(tag: { label: string }): void {
    this.user()!.tags = this.user()!.tags.filter((item) => item.label !== tag.label);
  }
}
