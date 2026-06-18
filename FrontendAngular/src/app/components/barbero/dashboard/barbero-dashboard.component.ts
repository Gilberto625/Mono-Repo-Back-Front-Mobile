import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { CitaService } from '../../../services/cita.service';
import { ServicioService } from '../../../services/servicio.service';

@Component({
  selector: 'app-barbero-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent],
  template: `
    <div class="layout-sidebar">
      <app-sidebar rol="barbero"></app-sidebar>

      <main class="main-content">
        <div class="flex-between mb-lg">
          <div>
            <h1>¡Hola, Carlos!</h1>
            <p class="text-muted">{{ fechaHoy }}</p>
          </div>
          <div class="avatar avatar-lg">CM</div>
        </div>

        <!-- Citas del día -->
        <div class="card mb-lg proxima-cita">
          <div class="flex-between">
            <div>
              <p class="text-small" style="color: rgba(255,255,255,0.7);">Citas de hoy</p>
              <h2 style="color: white; margin: var(--spacing-sm) 0;">{{ citasHoy }} citas programadas</h2>
              @if (proximaCita) {
                <p style="color: var(--color-accent);">Próxima: {{ proximaCita.hora }} - Cliente</p>
                <p class="text-small" style="color: rgba(255,255,255,0.7);">{{ getServicioNombre(proximaCita.servicioId) }}</p>
              }
            </div>
            <div class="text-right">
              <span class="badge badge-gold">En curso</span>
              <div class="mt-md">
                <a routerLink="/barbero/agenda" class="btn btn-secondary btn-sm" style="color: white; border-color: white;">Ver agenda</a>
              </div>
            </div>
          </div>
        </div>

        <!-- Stats -->
        <div class="stats-grid mb-lg">
          <div class="stat-card">
            <div class="stat-card-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="4" width="18" height="18" rx="2"/>
                <line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="8" y1="2" x2="8" y2="6"/>
              </svg>
            </div>
            <p class="stat-card-value">{{ citasHoy }}</p>
            <p class="stat-card-label">Citas hoy</p>
          </div>
          <div class="stat-card">
            <div class="stat-card-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="22,12 18,12 15,21 9,3 6,12 2,12"/>
              </svg>
            </div>
            <p class="stat-card-value">{{ citasCompletadas }}</p>
            <p class="stat-card-label">Completadas</p>
          </div>
          <div class="stat-card">
            <div class="stat-card-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12,6 12,12 16,14"/>
              </svg>
            </div>
            <p class="stat-card-value">{{ citasPendientes }}</p>
            <p class="stat-card-label">Pendientes</p>
          </div>
          <div class="stat-card">
            <div class="stat-card-icon" style="background: var(--color-success-light);">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2">
                <line x1="12" y1="1" x2="12" y2="23"/>
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
              </svg>
            </div>
            <p class="stat-card-value">\$2,450</p>
            <p class="stat-card-label">Ingresos hoy</p>
          </div>
        </div>

        <!-- Citas en tiempo real -->
        <h3 class="mb-md">Citas en tiempo real</h3>
        <div class="card mb-lg">
          <div class="list">
            @for (cita of citasDelDia; track cita.id) {
              <div class="list-item">
                <div class="avatar">{{ cita.clienteId.substring(0, 2).toUpperCase() }}</div>
                <div class="list-item-content">
                  <p class="list-item-title">Cliente {{ cita.clienteId }}</p>
                  <p class="list-item-subtitle">{{ getServicioNombre(cita.servicioId) }} - {{ cita.hora }}</p>
                </div>
                <span class="badge" [class]="getBadgeClass(cita.estado)">{{ getEstadoLabel(cita.estado) }}</span>
              </div>
            } @empty {
              <div class="list-item">
                <p class="text-muted mb-0">No hay citas programadas para hoy</p>
              </div>
            }
          </div>
        </div>

        <!-- Resumen servicios -->
        <h3 class="mb-md">Resumen de servicios realizados</h3>
        <div class="grid">
          <div class="card">
            <h4 class="mb-sm">Servicios de hoy</h4>
            <div class="list">
              <div class="list-item">
                <div class="list-item-content">
                  <p class="list-item-title">Corte clásico</p>
                </div>
                <span class="text-muted">3</span>
              </div>
              <div class="list-item">
                <div class="list-item-content">
                  <p class="list-item-title">Corte + Barba</p>
                </div>
                <span class="text-muted">2</span>
              </div>
              <div class="list-item">
                <div class="list-item-content">
                  <p class="list-item-title">Afeitado clásico</p>
                </div>
                <span class="text-muted">1</span>
              </div>
            </div>
          </div>
          <div class="card">
            <h4 class="mb-sm">Acciones rápidas</h4>
            <a routerLink="/barbero/agenda" class="btn btn-primary btn-block mb-sm">Ver agenda completa</a>
            <a routerLink="/barbero/tiempos" class="btn btn-secondary btn-block mb-sm">Ajustar tiempos</a>
            <a routerLink="/barbero/notificaciones" class="btn btn-text btn-block">Ver notificaciones</a>
          </div>
        </div>
      </main>
    </div>

    <!-- Mobile Nav -->
    <nav class="navbar-mobile">
      <a routerLink="/barbero" routerLinkActive="active" [routerLinkActiveOptions]="{exact: true}" class="navbar-mobile-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
        Inicio
      </a>
      <a routerLink="/barbero/agenda" routerLinkActive="active" class="navbar-mobile-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/></svg>
        Agenda
      </a>
      <a routerLink="/barbero/tiempos" routerLinkActive="active" class="navbar-mobile-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>
        Tiempos
      </a>
      <a routerLink="/barbero/notificaciones" routerLinkActive="active" class="navbar-mobile-item">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/></svg>
        Alertas
      </a>
    </nav>
  `,
  styles: [`
    .proxima-cita {
      background: linear-gradient(135deg, var(--color-primary-dark), #3d3d3d);
      color: white;
    }
  `]
})
export class BarberoDashboardComponent {
  private citaService = inject(CitaService);
  private servicioService = inject(ServicioService);

  // En producción, filtrar por el barbero logueado
  citasDelDia = this.citaService.citasDelDia();
  proximaCita = this.citasDelDia.find(c => c.estado === 'confirmada' || c.estado === 'pendiente');

  get citasHoy(): number {
    return this.citasDelDia.length;
  }

  get citasCompletadas(): number {
    return this.citasDelDia.filter(c => c.estado === 'completada').length;
  }

  get citasPendientes(): number {
    return this.citasDelDia.filter(c => c.estado === 'pendiente' || c.estado === 'confirmada').length;
  }

  get fechaHoy(): string {
    return new Date().toLocaleDateString('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  }

  getServicioNombre(servicioId: string): string {
    return this.servicioService.getServicioById(servicioId)?.nombre || 'Servicio';
  }

  getBadgeClass(estado: string): string {
    const clases: Record<string, string> = {
      'pendiente': 'badge-warning',
      'confirmada': 'badge-outline',
      'en_curso': 'badge-gold',
      'completada': 'badge-success'
    };
    return clases[estado] || 'badge-outline';
  }

  getEstadoLabel(estado: string): string {
    const labels: Record<string, string> = {
      'pendiente': 'Pendiente',
      'confirmada': 'Confirmada',
      'en_curso': 'En espera',
      'completada': 'Completada'
    };
    return labels[estado] || estado;
  }
}
