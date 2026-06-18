import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
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
  seguimiento?: Array<{
    id: number;
    estado: string;
    estado_display: string;
    motivo: string;
    detalle: string;
    ubicacion: string;
    paqueteria: string;
    guia: string;
    usuario: string;
    fecha_evento: string;
  }>;
}

@Component({
  selector: 'app-secretaria-pedido-detalle',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './secretaria-pedido-detalle.component.html',
  styleUrl: './secretaria-pedido-detalle.component.css'
})
export class SecretariaPedidoDetalleComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  pedido = signal<Pedido | null>(null);
  cargando = signal(true);
  error = signal('');
  actualizando = signal(false);
  mensajeExito = signal('');
  mostrarComprobante = signal(false);
  registrandoSeguimiento = signal(false);
  paqueteriaEnvio = '';
  guiaEnvio = '';
  ubicacionEnvio = '';
  detalleEnvio = '';
  paqueteriasSugeridas = ['DHL', 'Estafeta', 'FedEx', 'Paquetexpress'];

  private readonly apiUrl = `${environment.apiUrl.replace(/\/$/, '')}/secretaria/pedidos`;

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.cargarPedido(+id);
    } else {
      this.error.set('ID de pedido no válido');
      this.cargando.set(false);
    }
  }

  cargarPedido(id: number): void {
    this.cargando.set(true);
    this.http.get<any>(`${this.apiUrl}/${id}/`, { withCredentials: true }).subscribe({
      next: (res) => {
        if (res?.ok) {
          this.pedido.set(res.pedido);
        } else {
          this.error.set('No se pudo cargar el pedido');
        }
        this.cargando.set(false);
      },
      error: () => {
        this.error.set('Error al cargar el pedido');
        this.cargando.set(false);
      }
    });
  }

  actualizarEstado(nuevoEstado: string): void {
    const p = this.pedido();
    if (!p) return;

    this.actualizando.set(true);
    this.mensajeExito.set('');
    this.error.set('');

    this.http.put<any>(
      `${this.apiUrl}/${p.id}/actualizar/`,
      {
        estado: nuevoEstado,
        paqueteria: this.paqueteriaEnvio,
        guia: this.guiaEnvio,
        ubicacion: this.ubicacionEnvio,
        detalle: this.detalleEnvio,
      },
      { withCredentials: true }
    ).subscribe({
      next: (res) => {
        if (res?.ok) {
          this.mensajeExito.set(res.mensaje);
          this.pedido.set({ ...p, estado: nuevoEstado });
          this.cargarPedido(p.id);
        }
        this.actualizando.set(false);
      },
      error: (err) => {
        this.error.set(err?.error?.error || 'Error al actualizar el pedido');
        this.actualizando.set(false);
      }
    });
  }

  volver(): void {
    this.router.navigate(['/secretaria/pedidos']);
  }

  toggleComprobante(): void {
    this.mostrarComprobante.update(v => !v);
  }

  registrarSeguimiento(): void {
    const p = this.pedido();
    if (!p || this.registrandoSeguimiento()) return;
    if (!this.detalleEnvio.trim() && !this.ubicacionEnvio.trim()) {
      this.error.set('Agrega detalle u ubicación para registrar seguimiento.');
      return;
    }
    this.registrandoSeguimiento.set(true);
    this.error.set('');
    this.mensajeExito.set('');
    this.http.post<any>(
      `${this.apiUrl}/${p.id}/seguimiento/`,
      {
        paqueteria: this.paqueteriaEnvio,
        guia: this.guiaEnvio,
        ubicacion: this.ubicacionEnvio,
        detalle: this.detalleEnvio,
      },
      { withCredentials: true }
    ).subscribe({
      next: (res) => {
        this.registrandoSeguimiento.set(false);
        if (res?.ok) {
          this.mensajeExito.set(res?.mensaje || 'Seguimiento registrado');
          this.detalleEnvio = '';
          this.ubicacionEnvio = '';
          this.cargarPedido(p.id);
          return;
        }
        this.error.set('No se pudo registrar seguimiento');
      },
      error: (err) => {
        this.registrandoSeguimiento.set(false);
        this.error.set(err?.error?.error || 'Error al registrar seguimiento');
      }
    });
  }

  // ============================================
  // HELPERS
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

  formatearFecha(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleDateString('es-MX', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }

  getInicialesCliente(nombre: string): string {
    if (!nombre) return '??';
    return nombre.split(' ').map(n => n[0]).slice(0, 2).join('').toUpperCase();
  }

  getAccionesDisponibles(): { estado: string; label: string; clase: string; icon: string }[] {
    const p = this.pedido();
    if (!p) return [];

    const acciones: { estado: string; label: string; clase: string; icon: string }[] = [];
    const e = p.estado;

    if (e === 'pendiente') {
      acciones.push(
        { estado: 'confirmado', label: 'Confirmar pedido', clase: 'btn-primary', icon: '✓' },
        { estado: 'cancelado', label: 'Cancelar', clase: 'btn-danger', icon: '✗' },
      );
    } else if (e === 'comprobando_pago') {
      acciones.push(
        { estado: 'pago_validado', label: 'Validar pago', clase: 'btn-success', icon: '✓' },
        { estado: 'cancelado', label: 'Rechazar / Cancelar', clase: 'btn-danger', icon: '✗' },
      );
    } else if (e === 'pago_validado') {
      acciones.push({ estado: 'confirmado', label: 'Confirmar pedido', clase: 'btn-primary', icon: '✓' });
    } else if (e === 'confirmado') {
      acciones.push(
        { estado: 'preparando', label: 'Iniciar preparación', clase: 'btn-primary', icon: '📦' },
        { estado: 'cancelado', label: 'Cancelar', clase: 'btn-danger', icon: '✗' },
      );
    } else if (e === 'preparando') {
      if (p.metodo_entrega === 'recoger_local') {
        acciones.push({ estado: 'listo_recoger', label: 'Listo para recoger', clase: 'btn-gold', icon: '🏪' });
      } else {
        acciones.push({ estado: 'enviado', label: 'Marcar como enviado', clase: 'btn-primary', icon: '🚚' });
      }
      acciones.push({ estado: 'cancelado', label: 'Cancelar', clase: 'btn-danger', icon: '✗' });
    } else if (e === 'listo_recoger') {
      acciones.push({ estado: 'entregado', label: 'Cliente recogió (pago validado)', clase: 'btn-success', icon: '✓' });
    } else if (e === 'enviado') {
      acciones.push(
        { estado: 'entregado', label: 'Confirmar entrega', clase: 'btn-success', icon: '✓' },
        { estado: 'cancelado', label: 'No entregado', clase: 'btn-danger', icon: '✗' },
      );
    }

    return acciones;
  }
}
