import {
  Directive,
  ElementRef,
  EventEmitter,
  HostBinding,
  HostListener,
  Input,
  OnInit,
  Output,
} from '@angular/core';

import { UserPanelFacade } from '../../../data-access/+state/user-panel.facade';
import { UserPanelService } from '../../../data-access/services/user-panel.service';

@Directive({
  selector: 'highlight',
  standalone: false,
})
export class Highlight implements OnInit {
  @Input() color = '#ffff00';
  @Output() highlighted = new EventEmitter<string>();

  @HostBinding('style.outline') outline = '1px solid #ffff00';
  @HostBinding('style.background') background = '#ffff00';

  lastUserName = '';

  constructor(
    private el: ElementRef<HTMLElement>,
    private facade: UserPanelFacade,
    private service: UserPanelService,
  ) {}

  ngOnInit(): void {
    this.el.nativeElement.innerHTML = '<b>' + this.lastUserName + '</b>';
    this.el.nativeElement.style.background = this.color;

    document.addEventListener('scroll', () => this.highlighted.emit(this.lastUserName));

    this.service.getUsers().subscribe((users) => {
      this.lastUserName = users[0]?.firstName;
    });
  }

  @HostListener('mouseenter')
  onEnter(): void {
    this.facade.loadUsers({ pageSize: 5 });
  }
}
