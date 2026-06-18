import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';

@Component({
  selector: 'app-secretaria-whatsapp',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './secretaria-whatsapp.component.html'
})
export class SecretariaWhatsappComponent {
  private route = inject(ActivatedRoute);
  phone = signal('');
  text = signal('');

  constructor() {
    this.route.queryParamMap.subscribe((params) => {
      const phone = String(params.get('phone') || '').trim();
      const text = String(params.get('text') || '').trim();
      this.phone.set(phone);
      this.text.set(text);
    });
  }

  get chatUrl(): string {
    const phone = this.phone();
    const text = this.text();
    if (!phone) return 'https://web.whatsapp.com/';
    const base = `https://web.whatsapp.com/send?phone=${encodeURIComponent(phone)}`;
    return text ? `${base}&text=${encodeURIComponent(text)}` : base;
  }

  abrirWhatsAppWeb(): void {
    window.open(this.chatUrl, '_blank', 'noopener,noreferrer');
  }
}
