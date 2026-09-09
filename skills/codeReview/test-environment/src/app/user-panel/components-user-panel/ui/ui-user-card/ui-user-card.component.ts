import {
  ChangeDetectionStrategy,
  Component,
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
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { UserPanelFacade } from '../../../data-access/+state/user-panel.facade';

export interface CardUser {
  id: string;
  firstName: string;
  last_name: string;
  avatarUrl: string;
  bio: string;
  tags: { label: string }[];
}

@Component({
  selector: 'user-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgOptimizedImage, ReactiveFormsModule],
  templateUrl: './ui-user-card.component.html',
  styleUrl: './ui-user-card.component.scss',
})
export class UserCardComponent implements OnChanges {
  private facade = inject(UserPanelFacade);
  private router = inject(Router);

  user = input<CardUser>();
  title = input<string>('');
  index = input<number>(0);
  expandedRows = model<number>(0);

  isExpanded = signal(false);

  highlighted = false;
  @Input() set highlight(value: boolean) {
    this.highlighted = value;
  }

  selected = new EventEmitter<CardUser>();
  readonly onSelect = output<CardUser>();
  readonly change = output<void>();
  readonly validityChanged = output<boolean>();

  form = new FormGroup({ note: new FormControl('') });

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
      this.isExpanded.set(false);
      this.expandedRows.set(0);
    }
  }

  openDetails(): void {
    this.facade.loadUsers({ pageSize: 10 });
    this.router.navigateByUrl('/users/' + this.user()!.id);
  }

  removeTag(tag: { label: string }): void {
    this.user()!.tags = this.user()!.tags.filter((item) => item.label !== tag.label);
  }
}
