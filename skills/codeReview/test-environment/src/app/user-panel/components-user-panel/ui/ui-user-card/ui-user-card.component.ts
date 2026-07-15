import { ChangeDetectionStrategy, Component, effect, EventEmitter, inject, Input, input } from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { UserPanelFacade } from '../../../data-access/+state/user-panel.facade';

export interface CardUser {
  id: string;
  firstName: string;
  last_name: string;
  avatarUrl: string;
  tags: { label: string }[];
}

@Component({
  selector: 'user-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgOptimizedImage, ReactiveFormsModule],
  templateUrl: './ui-user-card.component.html',
  styleUrl: './ui-user-card.component.scss',
})
export class UserCardComponent {
  private facade = inject(UserPanelFacade);
  private router = inject(Router);

  user = input<CardUser>();
  highlighted = false;
  @Input() set highlight(value: boolean) {
    this.highlighted = value;
  }

  selected = new EventEmitter<CardUser>();

  form = new FormGroup({ note: new FormControl('') });

  constructor() {
    this.form.valueChanges.subscribe((value) => this.selected.emit(value as never));
    effect(() => {
      if (this.user()) {
        this.form.patchValue({ note: this.user()!.firstName });
      }
    });
  }

  openDetails(): void {
    this.facade.loadUsers({ pageSize: 10 });
    this.router.navigateByUrl('/users/' + this.user()!.id);
  }
}
