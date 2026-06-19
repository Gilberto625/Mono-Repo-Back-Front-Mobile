import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { environment } from '../../environments/environment';
import { API_ENDPOINTS, apiEndpoint } from '../core/api/api-endpoints';

export interface LogoConfig {
  logo_tipo: 'texto' | 'imagen';
  logo_texto: string;
  logo_texto_acento: string;
  logo_url: string;
  nombre_negocio: string;
}

@Injectable({
  providedIn: 'root'
})
export class LogoService {
  private http = inject(HttpClient);
  private apiUrl = environment.apiUrl;

  private _config = signal<LogoConfig>({
    logo_tipo: 'texto',
    logo_texto: 'Stylo',
    logo_texto_acento: 'Barber',
    logo_url: '',
    nombre_negocio: 'Stylo Barber'
  });

  /** True cuando ya se cargó la config al menos una vez */
  cargado = signal(false);

  config = this._config.asReadonly();

  constructor() {
    this.cargar();
  }

  cargar(): void {
    this.http.get<any>(apiEndpoint(this.apiUrl, API_ENDPOINTS.public.contact), {
      headers: new HttpHeaders({ 'Content-Type': 'application/json' })
    }).subscribe({
      next: (res) => {
        const c = res?.configuracion ?? res;
        if (!c) return;

        this._config.set({
          logo_tipo: c.logo_tipo || 'texto',
          logo_texto: c.logo_texto ?? c.logo_texto_parte1 ?? 'Stylo',
          logo_texto_acento: c.logo_texto_acento ?? c.logo_texto_parte2 ?? 'Barber',
          logo_url: c.logo_url || '',
          nombre_negocio: c.nombre_negocio || 'Stylo Barber'
        });
        this.cargado.set(true);
      }
    });
  }

  /** Fuerza recarga (tras guardar cambios en admin) */
  refrescar(): void {
    this.cargar();
  }
}
