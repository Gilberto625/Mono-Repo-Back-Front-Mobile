import { Component, computed, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { environment } from '../../../../environments/environment';

interface DashboardStats {
  citas_hoy: number;
  citas_por_confirmar: number;
  ventas_dia: number;
  transferencias_pendientes: number;
}

interface CitaHoyRow {
  id: number;
  cliente_nombre: string;
  cliente_telefono: string;
  servicio_nombre: string;
  barbero_nombre: string;
  fecha: string;
  hora: string;
  estado: string;
}

interface MovimientoDiaRow {
  hora: string;
  cliente_nombre: string;
  concepto: string;
  metodo: string;
  unidades: number;
  total: number;
}

@Component({
  selector: 'app-secretaria-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent],
  template: `
    <div class="layout-sidebar">
      <app-sidebar rol="secretaria"></app-sidebar>

      <main class="main-content">
        <div class="flex-between mb-lg">
          <div>
            <h1>Panel de Secretaría</h1>
            <p class="text-muted">Hoy es {{ fechaHoy }}</p>
          </div>
          <div class="avatar avatar-lg">SM</div>
        </div>

        @if (error()) {
          <p class="text-error mb-md">{{ error() }}</p>
        }

        <!-- Stats del día -->
        <div class="stats-grid mb-lg">
          <div class="stat-card">
            <div class="stat-card-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="4" width="18" height="18" rx="2"/>
                <line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="8" y1="2" x2="8" y2="6"/>
              </svg>
            </div>
            <p class="stat-card-value">{{ cargando() ? '…' : (stats()?.citas_hoy ?? 0) }}</p>
            <p class="stat-card-label">Citas del día</p>
          </div>
          <div class="stat-card">
            <div class="stat-card-icon" style="background: var(--color-warning-light);">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-warning)" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <p class="stat-card-value">{{ cargando() ? '…' : (stats()?.citas_por_confirmar ?? 0) }}</p>
            <p class="stat-card-label">Por confirmar</p>
          </div>
          <div class="stat-card">
            <div class="stat-card-icon" style="background: var(--color-success-light);">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2">
                <line x1="12" y1="1" x2="12" y2="23"/>
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
              </svg>
            </div>
            <p class="stat-card-value">
              {{ cargando() ? '…' : ('$' + (stats()?.ventas_dia | number: '1.2-2')) }}
            </p>
            <p class="stat-card-label">Ventas del día</p>
          </div>
          <div class="stat-card">
            <div class="stat-card-icon" style="background: var(--color-info-light);">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-info)" stroke-width="2">
                <rect x="1" y="4" width="22" height="16" rx="2"/>
                <line x1="1" y1="10" x2="23" y2="10"/>
              </svg>
            </div>
            <p class="stat-card-value">{{ cargando() ? '…' : (stats()?.transferencias_pendientes ?? 0) }}</p>
            <p class="stat-card-label">Transferencias pendientes</p>
          </div>
        </div>

        <div class="grid">
          <!-- Citas del día -->
          <div class="card">
            <div class="flex-between mb-md">
              <h3>Citas del Día</h3>
              <a routerLink="/secretaria/agenda" class="btn btn-text btn-sm">Ver todas</a>
            </div>
            <ul class="list">
              @for (cita of citasDelDiaPreview(); track cita.id) {
                <li class="list-item">
                  <div class="avatar">{{ inicialesCliente(cita.cliente_nombre) }}</div>
                  <div style="flex:1">
                    <p class="mb-0"><strong>{{ cita.cliente_nombre }}</strong></p>
                    <p class="text-small mb-0">{{ cita.servicio_nombre }} — {{ cita.barbero_nombre }}</p>
                  </div>
                  <div class="text-right">
                    <span class="badge" [ngClass]="badgeClassCita(cita.estado)">
                      {{ etiquetaEstadoCita(cita.estado) }}
                    </span>
                    <p class="text-small mb-0">{{ cita.hora }}</p>
                  </div>
                </li>
              } @empty {
                <li class="list-item">
                  <p class="text-muted mb-0">{{ cargando() ? 'Cargando…' : 'No hay citas programadas para hoy' }}</p>
                </li>
              }
            </ul>
          </div>

          <!-- Confirmaciones pendientes -->
          <div class="card">
            <div class="flex-between mb-md">
              <h3>Confirmaciones Pendientes</h3>
              <span class="badge badge-warning">{{ citasPendientes().length }}</span>
            </div>
            <ul class="list">
              @for (cita of citasPendientes().slice(0, 3); track cita.id) {
                <li class="list-item">
                  <div style="flex:1">
                    <p class="mb-0"><strong>{{ cita.cliente_nombre }}</strong> — {{ cita.hora }}</p>
                    <p class="text-small mb-0">{{ cita.servicio_nombre }}</p>
                  </div>
                  <div class="flex flex-gap">
                    <button
                      type="button"
                      class="btn btn-primary btn-sm"
                      [disabled]="confirmandoId() === cita.id"
                      (click)="confirmarCita(cita.id)"
                    >
                      {{ confirmandoId() === cita.id ? '…' : 'Confirmar' }}
                    </button>
                    @if (telefonoLimpio(cita.cliente_telefono)) {
                      <a class="btn btn-text btn-sm" [href]="'tel:' + telefonoLimpio(cita.cliente_telefono)">Llamar</a>
                    } @else {
                      <span class="btn btn-text btn-sm" style="opacity:0.5;pointer-events:none">Llamar</span>
                    }
                  </div>
                </li>
              } @empty {
                <li class="list-item">
                  <p class="text-muted mb-0">No hay confirmaciones pendientes</p>
                </li>
              }
            </ul>
          </div>
        </div>

        <!-- Ventas del día (mostrador) -->
        <div class="card mt-lg">
          <div class="flex-between mb-md">
            <h3>Ventas del Día</h3>
            <a routerLink="/secretaria/ventas" class="btn btn-primary btn-sm">Nueva Venta</a>
          </div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Hora</th>
                  <th>Cliente</th>
                  <th>Concepto</th>
                  <th>Método</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                @for (m of movimientosDia(); track $index) {
                  <tr>
                    <td>{{ m.hora }}</td>
                    <td>{{ m.cliente_nombre }}</td>
                    <td>{{ m.concepto }}@if (m.unidades > 1) { (×{{ m.unidades }})}</td>
                    <td><span class="badge badge-info">{{ m.metodo }}</span></td>
                    <td class="text-gold"><strong>\${{ m.total | number: '1.2-2' }}</strong></td>
                  </tr>
                } @empty {
                  <tr>
                    <td colspan="5" class="text-muted">
                      {{ cargando() ? 'Cargando…' : 'Sin movimientos de mostrador registrados hoy' }}
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>

    <!-- Mobile Nav -->
    <nav class="navbar-mobile">
      <a routerLink="/secretaria" routerLinkActive="active" [routerLinkActiveOptions]="{exact: true}" class="navbar-mobile-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        Inicio
      </a>
      <a routerLink="/secretaria/agenda" routerLinkActive="active" class="navbar-mobile-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/></svg>
        Agenda
      </a>
      <a routerLink="/secretaria/ventas" routerLinkActive="active" class="navbar-mobile-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        Venta
      </a>
      <a routerLink="/secretaria/inventario" routerLinkActive="active" class="navbar-mobile-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        Inventario
      </a>
      <a routerLink="/secretaria/pedidos" routerLinkActive="active" class="navbar-mobile-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg>
        Pedidos
      </a>
    </nav>
  `
})
export class SecretariaDashboardComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl.replace(/\/$/, '');

  readonly cargando = signal(true);
  readonly error = signal('');
  readonly stats = signal<DashboardStats | null>(null);
  readonly citasHoy = signal<CitaHoyRow[]>([]);
  readonly movimientosDia = signal<MovimientoDiaRow[]>([]);
  readonly confirmandoId = signal<number | null>(null);

  readonly citasPendientes = computed(() =>
    this.citasHoy().filter((c) => c.estado === 'pendiente')
  );

  readonly citasDelDiaPreview = computed(() => this.citasHoy().slice(0, 4));

  ngOnInit(): void {
    this.cargarPanel();
  }

  get fechaHoy(): string {
    return new Date().toLocaleDateString('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }

  cargarPanel(): void {
    this.cargando.set(true);
    this.error.set('');
    this.http.get<any>(`${this.apiUrl}/secretaria/dashboard/`).subscribe({
      next: (res) => {
        if (res?.ok) {
          this.stats.set(res.stats ?? null);
          this.citasHoy.set(res.citas_hoy ?? []);
          this.movimientosDia.set(res.movimientos_dia ?? []);
        } else {
          this.error.set(res?.error || 'No se pudo cargar el panel.');
        }
        this.cargando.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.error || err?.error?.detail || 'No se pudo cargar el panel de secretaría.');
        this.cargando.set(false);
      }
    });
  }

  inicialesCliente(nombre: string): string {
    const parts = (nombre || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '??';
    if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  badgeClassCita(estado: string): string {
    const map: Record<string, string> = {
      pendiente: 'badge-warning',
      confirmada: 'badge-success',
      en_curso: 'badge-primary',
      completada: 'badge-success',
      cancelada: 'badge-error',
      no_asistio: 'badge-error'
    };
    return map[estado] || 'badge-secondary';
  }

  etiquetaEstadoCita(estado: string): string {
    const map: Record<string, string> = {
      pendiente: 'Pendiente',
      confirmada: 'Confirmada',
      en_curso: 'En curso',
      completada: 'Completada',
      cancelada: 'Cancelada',
      no_asistio: 'No asistió'
    };
    return map[estado] || estado;
  }

  telefonoLimpio(raw: string): string {
    return String(raw || '').replace(/\D/g, '');
  }

  confirmarCita(citaId: number): void {
    this.confirmandoId.set(citaId);
    this.http
      .put<any>(`${this.apiUrl}/secretaria/citas/${citaId}/actualizar/`, { estado: 'confirmada' })
      .subscribe({
        next: (res) => {
          this.confirmandoId.set(null);
          if (res?.ok) {
            this.cargarPanel();
          } else {
            this.error.set(res?.error || 'No se pudo confirmar la cita.');
          }
        },
        error: (err) => {
          this.confirmandoId.set(null);
          this.error.set(err?.error?.error || 'No se pudo confirmar la cita.');
        }
      });
  }
}
