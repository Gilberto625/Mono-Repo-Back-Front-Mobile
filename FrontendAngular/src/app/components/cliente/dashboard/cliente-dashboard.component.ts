import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { AuthService } from '../../../services/auth.service';
import { CarritoService } from '../../../services/carrito.service';
import { CitaService } from '../../../services/cita.service';

interface ProximaCita {
  id: number;
  servicio_nombre: string;
  servicio_imagen: string;
  fecha: string;
  hora: string;
  duracion_minutos: number;
  estado: string;
  precio_total: number;
  anticipo_pagado: number;
}

interface DashboardStats {
  citas_totales: number;
  citas_completadas: number;
  citas_pendientes: number;
  total_pedidos: number;
  pedidos_activos: number;
  gasto_total: number;
  proxima_cita: ProximaCita | null;
  nombre: string;
  apellido: string;
  avatar_url: string;
  email: string;
}

@Component({
  selector: 'app-cliente-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './cliente-dashboard.component.html',
  styleUrl: './cliente-dashboard.component.css'
})
export class ClienteDashboardComponent implements OnInit {
  private authService = inject(AuthService);
  private citaService = inject(CitaService);
  private router = inject(Router);
  carritoService = inject(CarritoService);

  cargando = signal(true);
  stats = signal<DashboardStats | null>(null);

  // Datos del usuario
  nombreUsuario = signal('Usuario');
  inicialesUsuario = signal('U');
  avatarUrl = signal('');

  // Próxima cita
  proximaCita = signal<ProximaCita | null>(null);

  // Stats
  citasTotales = signal(0);
  totalPedidos = signal(0);
  citasPendientes = signal(0);
  pedidosActivos = signal(0);
  gastoTotal = signal(0);

  ngOnInit(): void {
    this.cargarDashboard();
  }

  private cargarDashboard(): void {
    this.cargando.set(true);

    // Datos locales del usuario como fallback inmediato
    const usuario = this.authService.getCurrentUser();
    if (usuario) {
      const nombre = usuario.nombre || usuario.username || usuario.email?.split('@')[0] || 'Usuario';
      this.nombreUsuario.set(nombre);
      this.inicialesUsuario.set(this.calcularIniciales(nombre, usuario.apellido || ''));
      this.avatarUrl.set(usuario.avatar_url || '');
    }

    // Cargar stats del backend
    this.citaService.obtenerDashboardCliente<DashboardStats>().subscribe({
      next: (res) => {
        if (res.ok && res.stats) {
          const s = res.stats;
          this.stats.set(s);
          this.nombreUsuario.set(s.nombre || this.nombreUsuario());
          this.inicialesUsuario.set(this.calcularIniciales(s.nombre, s.apellido));
          this.avatarUrl.set(s.avatar_url || '');
          this.proximaCita.set(s.proxima_cita);
          this.citasTotales.set(s.citas_totales);
          this.totalPedidos.set(s.total_pedidos);
          this.citasPendientes.set(s.citas_pendientes);
          this.pedidosActivos.set(s.pedidos_activos);
          this.gastoTotal.set(s.gasto_total);
        }
        this.cargando.set(false);
      },
      error: () => {
        this.cargando.set(false);
      }
    });
  }

  private calcularIniciales(nombre: string, apellido: string): string {
    const n = (nombre || '').trim();
    const a = (apellido || '').trim();
    if (n && a) return (n[0] + a[0]).toUpperCase();
    if (n) return n.substring(0, 2).toUpperCase();
    return 'U';
  }

  formatearFecha(fecha: string): string {
    try {
      const d = new Date(fecha + 'T00:00:00');
      return d.toLocaleDateString('es-MX', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      });
    } catch {
      return fecha;
    }
  }

  formatearHora(hora: string): string {
    try {
      const [h, m] = hora.split(':');
      const hNum = parseInt(h, 10);
      const ampm = hNum >= 12 ? 'PM' : 'AM';
      const h12 = hNum > 12 ? hNum - 12 : hNum === 0 ? 12 : hNum;
      return `${h12}:${m} ${ampm}`;
    } catch {
      return hora;
    }
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

  getEstadoClass(estado: string): string {
    const clases: Record<string, string> = {
      'pendiente': 'badge-warning',
      'confirmada': 'badge-gold',
      'en_curso': 'badge-info',
      'completada': 'badge-success',
      'cancelada': 'badge-error',
    };
    return clases[estado] || 'badge-gold';
  }

  get tieneAvatar(): boolean {
    return !!this.avatarUrl();
  }

  citasCompletadas(): number {
    const t = this.citasTotales();
    const p = this.citasPendientes();
    return t > 0 ? t - p : 0;
  }

  tieneGastoAcumulado(): boolean {
    return this.gastoTotal() > 0;
  }

  tieneItemsEnCarrito(): boolean {
    return this.carritoService.cantidadItems() > 0;
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
