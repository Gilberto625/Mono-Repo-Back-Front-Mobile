import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { AdminService, DashboardStats, Producto, TopServicioHoy, HorarioDemanda } from '../../../services/admin.service';
import { AuthService } from '../../../services/auth.service';

@Component({
  selector: 'app-admin-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './admin-dashboard.component.html',
  styleUrl: './admin-dashboard.component.css'
})
export class AdminDashboardComponent implements OnInit {
  private readonly adminService = inject(AdminService);
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  private readonly dashSnapKey = 'admin_dashboard_v1';
  private readonly dashSnapMaxAgeMs = 5 * 60 * 1000;

  /** Sin datos aún (ni snapshot): mostrar placeholders en tarjetas. */
  statsPending = true;
  /** Ya hay datos en pantalla y llega una actualización en segundo plano. */
  statsRefreshing = false;
  error = '';
  
  nombreAdmin = 'Administrador';
  inicialesAdmin = 'AD';
  
  stats: DashboardStats = {
    ventas_dia: 0,
    citas_hoy: 0,
    citas_pendientes: 0,
    barberos_activos: 0,
    barberos_en_descanso: 0,
    productos_stock_bajo: 0,
    total_clientes: 0,
    servicios_activos: 0,
    productos_activos: 0
  };
  
  productosStockBajo: Producto[] = [];
  topServicios: TopServicioHoy[] = [];
  horariosPopulares: HorarioDemanda[] = [];

  mostrarModalReabastecer = false;
  guardandoStock = false;
  productoReabastecer: (Producto & { stock_minimo?: number }) | null = null;
  cantidadReabastecer = 0;
  errorReabastecer = '';

  ngOnInit(): void {
    const usuario = this.authService.getCurrentUser();
    
    // Verificar que sea admin
    if (usuario?.rol !== 'admin') {
      this.router.navigate(['/login']);
      return;
    }
    
    // Establecer nombre del admin
    if (usuario.nombre) {
      this.nombreAdmin = usuario.nombre;
      this.inicialesAdmin = usuario.nombre.substring(0, 2).toUpperCase();
    } else if (usuario.username) {
      this.nombreAdmin = usuario.username;
      this.inicialesAdmin = usuario.username.substring(0, 2).toUpperCase();
    }

    if (this.restaurarSnapshot()) {
      this.statsPending = false;
    }

    this.cargarDatos();
  }

  private restaurarSnapshot(): boolean {
    try {
      const raw = sessionStorage.getItem(this.dashSnapKey);
      if (!raw) {
        return false;
      }
      const parsed = JSON.parse(raw) as { at?: number; body?: unknown };
      if (!parsed?.body || typeof parsed.at !== 'number') {
        return false;
      }
      if (Date.now() - parsed.at > this.dashSnapMaxAgeMs) {
        return false;
      }
      const response = parsed.body as {
        ok?: boolean;
        stats?: DashboardStats;
        productos_stock_bajo?: Producto[];
        top_servicios?: TopServicioHoy[];
        horarios_mayor_demanda?: HorarioDemanda[];
      };
      if (!response.ok || !response.stats) {
        return false;
      }
      this.stats = response.stats;
      this.productosStockBajo = response.productos_stock_bajo || [];
      this.topServicios = response.top_servicios || [];
      this.horariosPopulares = response.horarios_mayor_demanda || [];
      return true;
    } catch {
      return false;
    }
  }

  private guardarSnapshot(response: {
    ok?: boolean;
    stats?: DashboardStats;
    productos_stock_bajo?: Producto[];
    top_servicios?: TopServicioHoy[];
    horarios_mayor_demanda?: HorarioDemanda[];
  }): void {
    if (!response.ok || !response.stats) {
      return;
    }
    try {
      sessionStorage.setItem(
        this.dashSnapKey,
        JSON.stringify({ at: Date.now(), body: response })
      );
    } catch {
      /* ignore quota / private mode */
    }
  }

  cargarDatos(): void {
    this.error = '';
    if (this.statsPending) {
      this.statsRefreshing = false;
    } else {
      this.statsRefreshing = true;
    }

    this.adminService.getDashboardStats().subscribe({
      next: (response) => {
        this.statsPending = false;
        this.statsRefreshing = false;
        if (response.ok) {
          this.stats = response.stats;
          this.productosStockBajo = response.productos_stock_bajo || [];
          this.topServicios = response.top_servicios || [];
          this.horariosPopulares = response.horarios_mayor_demanda || [];
          this.guardarSnapshot(response);
        } else {
          this.error = response.error || 'Error al cargar datos';
        }
      },
      error: (err) => {
        this.statsPending = false;
        this.statsRefreshing = false;
        console.error('Error cargando dashboard:', err);
        const detail =
          err?.error?.detail ||
          err?.error?.error ||
          (typeof err?.error === 'string' ? err.error : '');
        if (detail && typeof detail === 'string' && detail.trim()) {
          this.error = detail.trim();
        } else if (err?.status === 503) {
          this.error =
            'El servidor no pudo preparar las estadísticas (base de datos ocupada o no disponible). Reintenta en unos segundos.';
        } else if (err?.status === 0) {
          this.error = 'No se pudo conectar con el servidor. Verifica que el backend esté corriendo.';
        } else {
          this.error =
            'No se pudieron cargar las estadísticas. Usa Reintentar o comprueba el servidor.';
        }
      }
    });
  }

  get fechaHoy(): string {
    return new Date().toLocaleDateString('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    });
  }

  get porcentajeVentasTexto(): string {
    const p = this.stats.porcentaje_ventas_vs_ayer;
    if (p == null) return '';
    const signo = p >= 0 ? '+' : '';
    return `${signo}${p}% vs ayer`;
  }

  getStockMinimo(producto: Producto & { stock_minimo?: number }): number {
    return producto.stock_minimo ?? (producto as any).stockMinimo ?? 0;
  }

  abrirModalReabastecer(producto: Producto & { stock_minimo?: number }): void {
    this.productoReabastecer = producto;
    this.cantidadReabastecer = 0;
    this.errorReabastecer = '';
    this.mostrarModalReabastecer = true;
  }

  cerrarModalReabastecer(): void {
    this.mostrarModalReabastecer = false;
    this.productoReabastecer = null;
    this.cantidadReabastecer = 0;
    this.errorReabastecer = '';
  }

  get modalReabastecerVisible(): boolean {
    return this.mostrarModalReabastecer && !!this.productoReabastecer;
  }

  guardarReabastecer(): void {
    if (!this.productoReabastecer || this.cantidadReabastecer <= 0) {
      this.errorReabastecer = 'Ingresa una cantidad mayor a 0';
      return;
    }
    this.guardandoStock = true;
    this.errorReabastecer = '';
    this.adminService.actualizarStock(
      this.productoReabastecer.id,
      this.cantidadReabastecer,
      'sumar'
    ).subscribe({
      next: (response) => {
        this.guardandoStock = false;
        const ok = response?.ok !== false;
        if (ok) {
          this.cerrarModalReabastecer();
          this.cargarDatos();
        } else {
          this.errorReabastecer = response?.error || 'Error al actualizar stock';
        }
      },
      error: (err) => {
        this.guardandoStock = false;
        this.errorReabastecer = err?.error?.error || 'Error de conexión';
      }
    });
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
