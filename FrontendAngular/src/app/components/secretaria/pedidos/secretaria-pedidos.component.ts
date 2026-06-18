import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpParams } from '@angular/common/http';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { environment } from '../../../../environments/environment';

interface ItemPedido {
  id: number;
  producto_id: number;
  producto_nombre: string;
  producto_imagen: string;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
}

interface Pedido {
  id: number;
  cliente_nombre: string;
  cliente_email: string;
  cliente_telefono: string;
  cliente_avatar: string;
  estado: string;
  metodo_entrega: string;
  metodo_pago: string;
  direccion_entrega: string;
  subtotal: number;
  descuento: number;
  costo_envio: number;
  total: number;
  codigo_descuento: string;
  notas: string;
  comprobante_url: string;
  fecha_creacion: string;
  fecha_actualizacion: string;
  items: ItemPedido[];
}

interface Contadores {
  total: number;
  pendientes: number;
  comprobando_pago: number;
  confirmados: number;
  preparando: number;
}

@Component({
  selector: 'app-secretaria-pedidos',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './secretaria-pedidos.component.html',
  styleUrl: './secretaria-pedidos.component.css'
})
export class SecretariaPedidosComponent implements OnInit { // Gestión de pedidos para secretaría
  private readonly http = inject(HttpClient);

  pedidos = signal<Pedido[]>([]);
  contadores = signal<Contadores>({ total: 0, pendientes: 0, comprobando_pago: 0, confirmados: 0, preparando: 0 });
  cargando = signal(true);
  error = signal('');

  // Filtros
  filtroEstado = signal('');
  filtroMetodoPago = signal('');
  busqueda = signal('');

  private readonly apiUrl = `${environment.apiUrl.replace(/\/$/, '')}/secretaria/pedidos`;
  private readonly cacheKey = 'secretaria_pedidos_lista_v1';
  private readonly cacheTtlMs = 20 * 1000;
  private inFlight = false;

  ngOnInit(): void {
    const cached = this.readCache();
    if (cached?.pedidos?.length) {
      this.pedidos.set(cached.pedidos);
      this.contadores.set(cached.contadores);
      this.cargando.set(false);
    }
    this.cargarPedidos();
  }

  cargarPedidos(): void {
    if (this.inFlight) return;
    if (this.isCacheFresh() && this.pedidos().length > 0) return;

    this.inFlight = true;
    this.cargando.set(this.pedidos().length === 0);
    this.error.set('');

    let params = new HttpParams();
    const estado = (this.filtroEstado() || '').trim();
    const metodoPago = (this.filtroMetodoPago() || '').trim();
    const buscar = (this.busqueda() || '').trim();
    if (estado) params = params.set('estado', estado);
    if (metodoPago) params = params.set('metodo_pago', metodoPago);
    if (buscar) params = params.set('buscar', buscar);

    this.http.get<any>(`${this.apiUrl}/`, { params, withCredentials: true }).subscribe({
      next: (res) => {
        if (res?.ok) {
          this.pedidos.set(res.pedidos || []);
          this.contadores.set(res.contadores || { total: 0, pendientes: 0, comprobando_pago: 0, confirmados: 0, preparando: 0 });
          // Cache solo la carga base (sin filtros) para instantáneo.
          if (!estado && !metodoPago && !buscar) {
            this.writeCache({
              pedidos: res.pedidos || [],
              contadores: res.contadores || { total: 0, pendientes: 0, comprobando_pago: 0, confirmados: 0, preparando: 0 },
            });
          }
        }
        this.cargando.set(false);
        this.inFlight = false;
      },
      error: (err) => {
        const status = err?.status;
        this.error.set(status ? `Error ${status} al cargar pedidos` : 'Error al cargar pedidos');
        this.cargando.set(false);
        this.inFlight = false;
      }
    });
  }

  aplicarFiltros(): void {
    this.cargarPedidos();
  }

  limpiarFiltros(): void {
    this.filtroEstado.set('');
    this.filtroMetodoPago.set('');
    this.busqueda.set('');
    this.cargarPedidos();
  }

  // ============================================
  // HELPERS DE DISPLAY
  // ============================================

  getEstadoLabel(estado: string): string {
    const labels: Record<string, string> = {
      'pendiente': 'Pendiente',
      'comprobando_pago': 'Comprobando pago',
      'pago_validado': 'Pago validado',
      'confirmado': 'Confirmado',
      'preparando': 'Preparando',
      'listo_recoger': 'Listo para recoger',
      'enviado': 'Enviado',
      'entregado': 'Entregado',
      'cancelado': 'Cancelado',
    };
    return labels[estado] || estado;
  }

  getEstadoClass(estado: string): string {
    const clases: Record<string, string> = {
      'pendiente': 'badge-warning',
      'comprobando_pago': 'badge-info',
      'pago_validado': 'badge-info',
      'confirmado': 'badge-success',
      'preparando': 'badge-primary',
      'listo_recoger': 'badge-gold',
      'enviado': 'badge-primary',
      'entregado': 'badge-success',
      'cancelado': 'badge-error',
    };
    return clases[estado] || 'badge-secondary';
  }

  getEntregaLabel(metodo: string): string {
    const labels: Record<string, string> = {
      'recoger_local': 'Recoger en tienda',
      'moto_mandado': 'Moto mandado',
      'paqueteria': 'Paquetería',
    };
    return labels[metodo] || metodo;
  }

  getPagoLabel(metodo: string): string {
    const labels: Record<string, string> = {
      'efectivo': 'Efectivo',
      'tarjeta': 'Tarjeta',
      'transferencia': 'Transferencia',
    };
    return labels[metodo] || metodo;
  }

  getPagoIcon(metodo: string): string {
    const icons: Record<string, string> = {
      'efectivo': '💵',
      'tarjeta': '💳',
      'transferencia': '🏦',
    };
    return icons[metodo] || '💰';
  }

  formatearFecha(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('es-MX', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  getInicialesCliente(nombre: string): string {
    if (!nombre) return '??';
    return nombre.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
  }

  private isCacheFresh(): boolean {
    try {
      const raw = sessionStorage.getItem(this.cacheKey);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { at?: number; value?: { pedidos: Pedido[]; contadores: Contadores } };
      if (!parsed?.value || typeof parsed.at !== 'number') return false;
      return Date.now() - parsed.at <= this.cacheTtlMs;
    } catch {
      return false;
    }
  }

  private readCache(): { pedidos: Pedido[]; contadores: Contadores } | null {
    try {
      const raw = sessionStorage.getItem(this.cacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { at?: number; value?: { pedidos: Pedido[]; contadores: Contadores } };
      if (!parsed?.value) return null;
      return parsed.value;
    } catch {
      return null;
    }
  }

  private writeCache(value: { pedidos: Pedido[]; contadores: Contadores }): void {
    try {
      sessionStorage.setItem(this.cacheKey, JSON.stringify({ at: Date.now(), value }));
    } catch {
      /* ignore */
    }
  }

}
