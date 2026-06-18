import { Component, OnInit, DestroyRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AdminService } from '../../../services/admin.service';
import { LogoService } from '../../../services/logo.service';

@Component({
  selector: 'app-footer',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './footer.component.html',
  styleUrl: './footer.component.css'
})
export class FooterComponent implements OnInit {
  private adminService = inject(AdminService);
  logoService = inject(LogoService);
  private destroyRef = inject(DestroyRef);

  redes = {
    facebook_url: '',
    instagram_url: '',
    x_url: '',
    tiktok_url: '',
    whatsapp_url: '',
    google_maps_url: '',
    apple_maps_url: ''
  };

  get tieneRedes(): boolean {
    return !!(this.redes.facebook_url || this.redes.instagram_url || this.redes.x_url || this.redes.tiktok_url || this.redes.whatsapp_url);
  }

  ngOnInit(): void {
    this.adminService.configuracionPublica$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        if (!res?.ok || !res.configuracion) return;
        this.aplicarConfiguracion(res.configuracion);
      });

    this.adminService.getConfiguracionPublica().subscribe({
      next: (data: any) => {
        const c = data?.configuracion ?? data;
        if (!c) return;
        this.aplicarConfiguracion(c);
      }
    });

    this.adminService.refrescarConfiguracionPublica();
  }

  private aplicarConfiguracion(c: any): void {
    this.redes.facebook_url = c.facebook_url || '';
    this.redes.instagram_url = c.instagram_url || '';
    this.redes.x_url = c.x_url || '';
    this.redes.tiktok_url = c.tiktok_url || '';
    this.redes.whatsapp_url = c.whatsapp_url || '';
    this.redes.google_maps_url = c.google_maps_url || '';
    this.redes.apple_maps_url = c.apple_maps_url || '';
  }
}
