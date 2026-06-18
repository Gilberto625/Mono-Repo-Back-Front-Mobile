import { Component, OnInit, effect, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LogoService, LogoConfig } from './services/logo.service';
import { ThemeService } from './services/theme.service';
import { ProductoService } from './services/producto.service';
import { environment } from '../environments/environment';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css'
})
export class AppComponent implements OnInit {
  title = 'frontendAngular';
  private logoService = inject(LogoService);
  private readonly themeService = inject(ThemeService);
  private readonly productoService = inject(ProductoService);

  constructor() {
    effect(() => {
      const cfg = this.logoService.config();
      this.aplicarBrandingGlobal(cfg);
    });
  }

  ngOnInit(): void {
    console.log('🎯 AppComponent inicializado');
    console.log('📍 Ubicación actual:', window.location.href);
    this.logoService.refrescar();
    // Calienta el cache del catálogo público para que /productos sea instantáneo.
    this.productoService.loadProductosPublicos();
  }

  private aplicarBrandingGlobal(cfg: LogoConfig): void {
    const nombre = String(cfg?.nombre_negocio || '').trim() || 'Stylo Barber';
    document.title = nombre;

    const logoUrl = this.normalizarLogoUrl(String(cfg?.logo_url || '').trim());
    if (!logoUrl) return;

    // Actualiza favicon principal y alias comunes para que navegador/PWA muestren la marca real.
    this.actualizarLink('icon', logoUrl);
    this.actualizarLink('shortcut icon', logoUrl);
    this.actualizarLink('apple-touch-icon', logoUrl);
  }

  private actualizarLink(rel: string, href: string): void {
    let link = document.querySelector(`link[rel="${rel}"]`) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.rel = rel;
      document.head.appendChild(link);
    }
    link.href = href;
  }

  private normalizarLogoUrl(raw: string): string {
    if (!raw) return '';
    if (raw.startsWith('data:image/')) return raw;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('/')) {
      try {
        const api = new URL(environment.apiUrl);
        return `${api.origin}${raw}`;
      } catch {
        return raw;
      }
    }
    return raw;
  }
}
