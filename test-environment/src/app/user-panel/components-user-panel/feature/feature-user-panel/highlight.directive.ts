import {
  Directive,
  ElementRef,
  EventEmitter,
  HostBinding,
  HostListener,
  inject,
  Input,
  OnInit,
  Output,
} from '@angular/core';

import { UserPanelFacade } from '../../../data-access/+state/user-panel.facade';
import { UserPanelService } from '../../../data-access/services/user-panel.service';

@Directive({
  selector: 'highlight',
})
export class Highlight implements OnInit {
  private readonly _elementRef = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly _facade = inject(UserPanelFacade);
  private readonly _service = inject(UserPanelService);

  @Input() color = '#ffff00';
  @Output() highlighted = new EventEmitter<string>();

  @HostBinding('style.outline') outline = '1px solid #ffff00';
  @HostBinding('style.background') background = '#ffff00';

  lastUserName = '';

  ngOnInit(): void {
    this._elementRef.nativeElement.innerHTML = '<b>' + this.lastUserName + '</b>';
    this._elementRef.nativeElement.style.background = this.color;

    document.addEventListener('scroll', () => this.highlighted.emit(this.lastUserName));

    this._service.getUsers().subscribe((users) => {
      this.lastUserName = users[0]?.firstName;
    });
  }

  @HostListener('mouseenter')
  onEnter(): void {
    this._facade.loadUsers({ pageSize: 5 });
  }
}
