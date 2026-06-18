import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { RouterModule } from '@angular/router';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { environment } from '../../../../environments/environment';

interface ItemPedido {
  id: number;
  producto_nombre: string;
  cantidad: number;
}

interface PedidoEntrega {
  id: number;
  cliente_nombre: string;
  estado: string;
  metodo_entrega: string;
  direccion_entrega: string;
  fecha_actualizacion: string;
  fecha_creacion: string;
  items: ItemPedido[];
}

type PeriodoFiltro = 'todos' | 'hoy' | 'semana' | 'mes';
type TabEntrega = 'pendientes' | 'entregados';
type TamPagina = 10 | 15;

@Component({
  selector: 'app-secretaria-entregas',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './secretaria-entregas.component.html',
  styleUrl: './secretaria-entregas.component.css',
})
export class SecretariaEntregasComponent implements OnInit {
  private http = inject(HttpClient);
  private apiUrl = `${environment.apiUrl}/secretaria/pedidos`;

  pedidos = signal<PedidoEntrega[]>([]);
  cargando = signal(true);
  error = signal('');
  exito = signal('');
  periodo = signal<PeriodoFiltro>('todos');
  tab = signal<TabEntrega>('pendientes');
  tamPagina = signal<TamPagina>(10);
  paginaActual = signal(1);
  actualizandoPedidoId = signal<number | null>(null);

  pendientes = computed(() =>
    this.pedidos().filter((p) => this.esPendienteEntrega(p) && this.enPeriodo(p.fecha_actualizacion || p.fecha_creacion))
  );

  entregados = computed(() =>
    this.pedidos().filter((p) => p.estado === 'entregado' && this.enPeriodo(p.fecha_actualizacion || p.fecha_creacion))
  );

  listaActiva = computed(() => (this.tab() === 'pendientes' ? this.pendientes() : this.entregados()));
  totalPaginas = computed(() => Math.max(1, Math.ceil(this.listaActiva().length / this.tamPagina())));
  paginas = computed(() => Array.from({ length: this.totalPaginas() }, (_, i) => i + 1));
  listaPaginada = computed(() => {
    const tam = this.tamPagina();
    const inicio = (this.paginaActual() - 1) * tam;
    return this.listaActiva().slice(inicio, inicio + tam);
  });

  porEntregar = computed(() => this.pendientes().length);
  envioDomicilio = computed(() => this.pendientes().filter((p) => p.metodo_entrega !== 'recoger_local').length);
  recogerTienda = computed(() => this.pendientes().filter((p) => p.metodo_entrega === 'recoger_local').length);
  entregadosCount = computed(() => this.entregados().length);

  ngOnInit(): void {
    this.cargarPedidos();
  }

  cargarPedidos(): void {
    this.cargando.set(true);
    this.error.set('');
    this.http.get<any>(`${this.apiUrl}/`, { withCredentials: true }).subscribe({
      next: (res) => {
        this.pedidos.set(res?.ok ? (res.pedidos || []) : []);
        this.paginaActual.set(1);
        this.cargando.set(false);
      },
      error: () => {
        this.error.set('No se pudo cargar el módulo de entregas.');
        this.cargando.set(false);
      },
    });
  }

  marcarEntregado(pedido: PedidoEntrega): void {
    this.actualizarEstado(pedido, 'entregado');
  }

  marcarDevuelto(pedido: PedidoEntrega): void {
    this.actualizarEstado(pedido, 'cancelado');
  }

  cambiarTab(tab: TabEntrega): void {
    this.tab.set(tab);
    this.paginaActual.set(1);
  }

  cambiarPeriodo(periodo: PeriodoFiltro): void {
    this.periodo.set(periodo);
    this.paginaActual.set(1);
  }

  cambiarTamPagina(raw: string): void {
    const n = Number(raw);
    this.tamPagina.set(n === 15 ? 15 : 10);
    this.paginaActual.set(1);
  }

  irPagina(pagina: number): void {
    const p = Math.max(1, Math.min(this.totalPaginas(), pagina));
    this.paginaActual.set(p);
  }

  paginaAnterior(): void {
    this.irPagina(this.paginaActual() - 1);
  }

  paginaSiguiente(): void {
    this.irPagina(this.paginaActual() + 1);
  }

  private actualizarEstado(pedido: PedidoEntrega, estado: 'entregado' | 'cancelado'): void {
    this.actualizandoPedidoId.set(pedido.id);
    this.error.set('');
    this.exito.set('');
    this.http
      .put<any>(
        `${this.apiUrl}/${pedido.id}/actualizar/`,
        { estado },
        { withCredentials: true }
      )
      .subscribe({
        next: (res) => {
          this.actualizandoPedidoId.set(null);
          if (res?.ok) {
            this.exito.set(res?.mensaje || 'Estado actualizado.');
            this.cargarPedidos();
            return;
          }
          this.error.set('No se pudo actualizar el estado de entrega.');
        },
        error: (err) => {
          this.actualizandoPedidoId.set(null);
          this.error.set(err?.error?.error || 'No se pudo actualizar el estado de entrega.');
        },
      });
  }

  esPendienteEntrega(p: PedidoEntrega): boolean {
    return p.estado === 'enviado' || p.estado === 'listo_recoger';
  }

  getEtiquetaMetodo(metodo: string): string {
    if (metodo === 'recoger_local') return 'Recoger en tienda';
    if (metodo === 'paqueteria') return 'Envío por paquetería';
    if (metodo === 'moto_mandado') return 'Envío a domicilio';
    return metodo || 'Entrega';
  }

  getClaseMetodo(metodo: string): string {
    if (metodo === 'recoger_local') return 'badge badge-warning';
    return 'badge badge-info';
  }

  private enPeriodo(rawIso: string): boolean {
    if (this.periodo() === 'todos') return true;
    if (!rawIso) return false;
    const fecha = new Date(rawIso);
    if (Number.isNaN(fecha.getTime())) return false;
    const hoy = new Date();

    if (this.periodo() === 'hoy') {
      return (
        fecha.getFullYear() === hoy.getFullYear() &&
        fecha.getMonth() === hoy.getMonth() &&
        fecha.getDate() === hoy.getDate()
      );
    }

    if (this.periodo() === 'semana') {
      const inicio = new Date(hoy);
      const dia = (inicio.getDay() + 6) % 7;
      inicio.setDate(inicio.getDate() - dia);
      inicio.setHours(0, 0, 0, 0);

      const fin = new Date(inicio);
      fin.setDate(fin.getDate() + 7);
      return fecha >= inicio && fecha < fin;
    }

    return fecha.getFullYear() === hoy.getFullYear() && fecha.getMonth() === hoy.getMonth();
  }
}
