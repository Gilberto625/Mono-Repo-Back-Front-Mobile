import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import {
  AdminService,
  Producto,
  ProductosCatalogBootstrap,
} from '../../../services/admin.service';
import { ModalService } from '../../../services/modal.service';

@Component({
  selector: 'app-productos-lista',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './productos-lista.component.html',
  styleUrl: './productos-lista.component.css',
})
export class ProductosListaComponent implements OnInit, OnDestroy {
  /** Tamaño fijo de página en el catálogo admin/secretaría (debe coincidir con la petición al API). */
  private static readonly CATALOGO_PRODUCTOS_POR_PAGINA = 8;

  private readonly adminService = inject(AdminService);
  private readonly modalService = inject(ModalService);
  private readonly router = inject(Router);

  productos: Producto[] = [];
  loading = true;
  listaRefreshing = false;

  page = 1;
  perPage = ProductosListaComponent.CATALOGO_PRODUCTOS_POR_PAGINA;
  total = 0;
  totalPages = 1;

  filtro = '';
  filtroCategoria = '';
  filtroMarca = '';
  /** Por defecto solo activos, así los eliminados (inactivos) no reaparecen al recargar */
  filtroEstado = 'activo';

  statsCatalogo = {
    disponibles: 0,
    stock_bajo: 0,
    agotados: 0,
  };
  marcasFiltro: string[] = [];

  mostrarModalStock = false;
  productoStock: Producto | null = null;
  cantidadStock = 0;
  imagenesConError = new Set<number>();

  private filtroSearchTimer: ReturnType<typeof setTimeout> | null = null;

  get esSecretaria(): boolean {
    return this.router.url.startsWith('/secretaria');
  }

  get catalogoBase(): string {
    return this.esSecretaria ? '/secretaria/catalogo' : '/admin/productos';
  }

  get rangoInicio(): number {
    if (this.total === 0) {
      return 0;
    }
    return (this.page - 1) * this.perPage + 1;
  }

  get rangoFin(): number {
    return Math.min(this.page * this.perPage, this.total);
  }

  ngOnInit(): void {
    const boot = this.adminService.getProductosCatalogBootstrap();
    if (boot && boot.query.perPage === ProductosListaComponent.CATALOGO_PRODUCTOS_POR_PAGINA) {
      this.hydrateFromCatalogBoot(boot);
      this.loading = false;
      this.imagenesConError.clear();
    }
    this.cargarProductos();
  }

  ngOnDestroy(): void {
    if (this.filtroSearchTimer) {
      clearTimeout(this.filtroSearchTimer);
      this.filtroSearchTimer = null;
    }
  }

  private hydrateFromCatalogBoot(b: ProductosCatalogBootstrap): void {
    this.page = b.query.page;
    this.perPage = ProductosListaComponent.CATALOGO_PRODUCTOS_POR_PAGINA;
    this.filtro = b.query.q;
    this.filtroCategoria = b.query.categoria;
    this.filtroMarca = b.query.marca;
    this.filtroEstado = b.query.estado;
    this.productos = b.productos.map((p) => ({ ...p }));
    this.total = b.total;
    this.totalPages = Math.max(1, b.total_pages);
    this.statsCatalogo = {
      disponibles: b.stats.disponibles,
      stock_bajo: b.stats.stock_bajo,
      agotados: b.stats.agotados,
    };
    this.marcasFiltro = [...b.marcas_filtro];
  }

  private buildCatalogQuery() {
    return {
      page: this.page,
      perPage: ProductosListaComponent.CATALOGO_PRODUCTOS_POR_PAGINA,
      q: this.filtro.trim(),
      categoria: this.filtroCategoria.trim(),
      marca: this.filtroMarca.trim(),
      estado: this.filtroEstado.trim() || 'activo',
    };
  }

  cargarProductos(): void {
    const paginaSolicitada = this.page;
    const hasInitialData = this.productos.length > 0;
    if (hasInitialData) {
      this.loading = false;
      this.listaRefreshing = true;
    } else {
      this.loading = true;
      this.listaRefreshing = false;
    }

    this.adminService.getProductos(false, this.buildCatalogQuery()).subscribe({
      next: (response) => {
        this.loading = false;
        this.listaRefreshing = false;
        if (response.ok) {
          this.applyCatalogResponse(response, paginaSolicitada);
        }
      },
      error: () => {
        this.loading = false;
        this.listaRefreshing = false;
        this.modalService.showError('Error al cargar productos');
      },
    });
  }

  private static numSeguro(v: unknown, fallback: number): number {
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v;
    }
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  private applyCatalogResponse(response: any, paginaSolicitada: number): void {
    const pageSize = ProductosListaComponent.CATALOGO_PRODUCTOS_POR_PAGINA;
    this.perPage = pageSize;

    let total = ProductosListaComponent.numSeguro(response.total, 0);
    const productos = Array.isArray(response.productos) ? response.productos : [];

    let totalPages = ProductosListaComponent.numSeguro(response.total_pages, Number.NaN);
    if (!Number.isFinite(totalPages) || totalPages < 1) {
      totalPages = Math.max(1, Math.ceil(total / pageSize));
    } else {
      totalPages = Math.max(1, Math.floor(totalPages));
    }

    let page = ProductosListaComponent.numSeguro(response.page, paginaSolicitada);
    if (!Number.isFinite(page) || page < 1) {
      page = paginaSolicitada;
    }

    if (total > 0 && page > totalPages) {
      this.page = totalPages;
      this.cargarProductos();
      return;
    }

    this.total = total;
    this.totalPages = totalPages;
    this.page = Math.min(Math.max(1, Math.floor(page)), totalPages);

    this.productos = productos;
    this.imagenesConError.clear();

    const st = response.stats;
    if (st && typeof st === 'object') {
      this.statsCatalogo = {
        disponibles: ProductosListaComponent.numSeguro(st.disponibles, 0),
        stock_bajo: ProductosListaComponent.numSeguro(st.stock_bajo, 0),
        agotados: ProductosListaComponent.numSeguro(st.agotados, 0),
      };
    }
    if (Array.isArray(response.marcas_filtro)) {
      this.marcasFiltro = [...response.marcas_filtro];
    }
  }

  /**
   * Botones de página con ventana alrededor de la actual y elipsis (1 … 5 6 7 … 112).
   */
  indicadoresPaginacion(): Array<{ kind: 'num'; n: number } | { kind: 'gap' }> {
    const max = this.totalPages;
    const cur = this.page;
    if (max <= 1) {
      return [];
    }
    const nums = new Set<number>();
    nums.add(1);
    nums.add(max);
    for (let d = -3; d <= 3; d++) {
      const x = cur + d;
      if (x >= 1 && x <= max) {
        nums.add(x);
      }
    }
    const sorted = [...nums].sort((a, b) => a - b);
    const out: Array<{ kind: 'num'; n: number } | { kind: 'gap' }> = [];
    let prev = 0;
    for (const n of sorted) {
      if (prev > 0 && n - prev > 1) {
        out.push({ kind: 'gap' });
      }
      out.push({ kind: 'num', n });
      prev = n;
    }
    return out;
  }

  onFiltroBusquedaInput(): void {
    if (this.filtroSearchTimer) {
      clearTimeout(this.filtroSearchTimer);
    }
    this.filtroSearchTimer = setTimeout(() => {
      this.filtroSearchTimer = null;
      this.aplicarFiltros();
    }, 350);
  }

  aplicarFiltros(): void {
    this.page = 1;
    this.cargarProductos();
  }

  limpiarFiltros(): void {
    if (this.filtroSearchTimer) {
      clearTimeout(this.filtroSearchTimer);
      this.filtroSearchTimer = null;
    }
    this.filtro = '';
    this.filtroCategoria = '';
    this.filtroMarca = '';
    this.filtroEstado = 'activo';
    this.page = 1;
    this.cargarProductos();
  }

  irAPagina(p: number): void {
    const next = Math.max(1, Math.min(Math.floor(p), this.totalPages));
    if (next === this.page) {
      return;
    }
    this.page = next;
    this.cargarProductos();
  }

  getCategoriaLabel(categoria: string): string {
    const labels: Record<string, string> = {
      cabello: 'Cabello',
      barba: 'Barba',
      facial: 'Facial',
      accesorios: 'Accesorios',
      kit: 'Kits',
    };
    return labels[categoria] || categoria;
  }

  getEstadoStock(producto: Producto): string {
    if (producto.stock === 0) return 'Agotado';
    if (producto.stock <= producto.stock_minimo) return 'Stock bajo';
    return 'Disponible';
  }

  tieneImagenValida(producto: Producto): boolean {
    return !!producto.imagen_url && !this.imagenesConError.has(producto.id);
  }

  onImagenError(productoId: number): void {
    this.imagenesConError.add(productoId);
  }

  inicialesProducto(nombre: string): string {
    const tokens = (nombre || '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return 'PR';
    if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
    return `${tokens[0][0] || ''}${tokens[1][0] || ''}`.toUpperCase();
  }

  toggleEstado(producto: Producto): void {
    const nuevoEstado = !producto.activo;
    this.adminService.actualizarProducto(producto.id, { activo: nuevoEstado }).subscribe({
      next: () => {
        this.modalService.showSuccess(nuevoEstado ? 'Producto activado' : 'Producto desactivado');
        this.cargarProductos();
      },
      error: () => this.modalService.showError('Error al cambiar estado'),
    });
  }

  abrirModalStock(producto: Producto): void {
    this.productoStock = producto;
    this.cantidadStock = 0;
    this.mostrarModalStock = true;
  }

  cerrarModalStock(): void {
    this.mostrarModalStock = false;
    this.productoStock = null;
  }

  guardarStock(): void {
    if (!this.productoStock || this.cantidadStock <= 0) return;

    this.adminService.actualizarStock(this.productoStock.id, this.cantidadStock, 'sumar').subscribe({
      next: (response) => {
        if (response.ok) {
          this.modalService.showSuccess(`Stock actualizado: ${response.stock_actual} unidades`);
          this.cerrarModalStock();
          this.cargarProductos();
        }
      },
      error: () => this.modalService.showError('Error al actualizar stock'),
    });
  }

  eliminarProducto(producto: Producto, event?: Event): void {
    if (event) {
      event.stopPropagation();
      event.preventDefault();
    }
    if (
      !confirm(
        `¿Eliminar permanentemente el producto "${producto.nombre}"?\n\nSi tiene ventas, pedidos o inventario relacionado, no se podrá eliminar y deberás desactivarlo.`
      )
    ) {
      return;
    }
    this.adminService.eliminarProducto(producto.id).subscribe({
      next: (res) => {
        this.modalService.showSuccess(res?.mensaje || 'Producto eliminado');
        this.cargarProductos();
      },
      error: (err) => {
        this.modalService.showError(
          err?.error?.error || err?.error?.detail || 'Error al eliminar producto'
        );
      },
    });
  }
}
