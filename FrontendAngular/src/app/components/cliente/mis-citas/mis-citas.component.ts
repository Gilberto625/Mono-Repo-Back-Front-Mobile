import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { environment } from '../../../../environments/environment';

interface CitaBackend {
  id: number;
  servicio_id: number;
  servicio_nombre: string;
  servicio_imagen: string;
  fecha: string;
  hora: string;
  duracion_minutos: number;
  estado: string;
  precio_total: number;
  anticipo_pagado: number;
  notas: string;
  fecha_creacion: string;
}

@Component({
  selector: 'app-mis-citas',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './mis-citas.component.html',
  styleUrl: './mis-citas.component.css'
})
export class MisCitasComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl.replace(/\/$/, '');

  private readonly cacheKey = 'cliente_mis_citas_v1';
  private readonly cacheTtlMs = 30 * 1000;
  private inFlight = false;

  citas = signal<CitaBackend[]>([]);
  cargando = signal(true);
  tabActivo = signal<'proximas' | 'pendientes' | 'completadas' | 'todas'>('proximas');

  ngOnInit(): void {
    const cached = this.readCache();
    if (cached?.length) {
      this.citas.set(cached);
      this.cargando.set(false);
    }
    this.cargarCitas();
  }

  private getHeaders(): HttpHeaders {
    const accessToken = localStorage.getItem('accessToken') || '';
    let headers = new HttpHeaders();
    if (accessToken) {
      headers = headers.set('Authorization', `Bearer ${accessToken}`);
    }
    return headers;
  }

  private cargarCitas(): void {
    if (this.inFlight) return;
    if (this.isCacheFresh()) return;

    this.inFlight = true;
    this.cargando.set(this.citas().length === 0);
    this.http.get<{ ok: boolean; citas: CitaBackend[] }>(
      `${this.apiUrl}/mis-citas/`,
      { headers: this.getHeaders(), withCredentials: true }
    ).subscribe({
      next: (res) => {
        if (res.ok) {
          this.citas.set(res.citas);
          this.writeCache(res.citas);
        }
        this.cargando.set(false);
        this.inFlight = false;
      },
      error: () => {
        this.cargando.set(false);
        this.inFlight = false;
      }
    });
  }

  private isCacheFresh(): boolean {
    try {
      const raw = sessionStorage.getItem(this.cacheKey);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { at?: number; citas?: CitaBackend[] };
      if (!Array.isArray(parsed?.citas) || typeof parsed.at !== 'number') return false;
      return Date.now() - parsed.at <= this.cacheTtlMs;
    } catch {
      return false;
    }
  }

  private readCache(): CitaBackend[] | null {
    try {
      const raw = sessionStorage.getItem(this.cacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { at?: number; citas?: CitaBackend[] };
      if (!Array.isArray(parsed?.citas)) return null;
      return parsed.citas;
    } catch {
      return null;
    }
  }

  private writeCache(citas: CitaBackend[]): void {
    try {
      sessionStorage.setItem(this.cacheKey, JSON.stringify({ at: Date.now(), citas }));
    } catch {
      /* ignore */
    }
  }

  get hoy(): string {
    return new Date().toISOString().split('T')[0];
  }

  get citasProximas(): CitaBackend[] {
    return this.citas().filter(c =>
      c.fecha >= this.hoy && (c.estado === 'pendiente' || c.estado === 'confirmada')
    );
  }

  get citasPendientes(): CitaBackend[] {
    return this.citas().filter(c => c.estado === 'pendiente');
  }

  get citasCompletadas(): CitaBackend[] {
    return this.citas().filter(c => c.estado === 'completada');
  }

  citasFiltradas(): CitaBackend[] {
    switch (this.tabActivo()) {
      case 'proximas':
        return this.citasProximas;
      case 'pendientes':
        return this.citasPendientes;
      case 'completadas':
        return this.citasCompletadas;
      case 'todas':
        return this.citas();
      default:
        return [];
    }
  }

  cambiarTab(tab: 'proximas' | 'pendientes' | 'completadas' | 'todas'): void {
    this.tabActivo.set(tab);
  }

  formatearFecha(fecha: string): string {
    try {
      const d = new Date(fecha + 'T00:00:00');
      return d.toLocaleDateString('es-MX', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
      });
    } catch {
      return fecha;
    }
  }

  formatearHora(hora: string): string {
    try {
      const [h, m] = hora.split(':');
      const hNum = Number.parseInt(h, 10);
      const ampm = hNum >= 12 ? 'PM' : 'AM';
      let h12 = hNum;
      if (hNum > 12) h12 = hNum - 12;
      if (hNum === 0) h12 = 12;
      return `${h12}:${m} ${ampm}`;
    } catch {
      return hora;
    }
  }

  getColorEstado(estado: string): string {
    const colores: Record<string, string> = {
      'pendiente': 'var(--color-warning, #eab308)',
      'confirmada': 'var(--color-accent, #c8a864)',
      'en_curso': 'var(--color-info, #3b82f6)',
      'completada': 'var(--color-success, #22c55e)',
      'cancelada': 'var(--color-error, #ef4444)',
      'no_asistio': 'var(--color-error, #ef4444)',
    };
    return colores[estado] || 'var(--color-accent)';
  }

  getBadgeClass(estado: string): string {
    const clases: Record<string, string> = {
      'pendiente': 'badge-warning',
      'confirmada': 'badge-success',
      'en_curso': 'badge-info',
      'completada': 'badge-success',
      'cancelada': 'badge-error',
      'no_asistio': 'badge-error',
    };
    return clases[estado] || '';
  }

  getEstadoLabel(estado: string): string {
    const labels: Record<string, string> = {
      'pendiente': 'Pendiente',
      'confirmada': 'Confirmada',
      'en_curso': 'En curso',
      'completada': 'Completada',
      'cancelada': 'Cancelada',
      'no_asistio': 'No asistió',
    };
    return labels[estado] || estado;
  }
}
