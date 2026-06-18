import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { AdminService, Producto } from '../../../services/admin.service';
import { ModalService } from '../../../services/modal.service';

interface MovimientoInventario {
  tipo: 'entrada' | 'salida' | 'ajuste';
  producto: string;
  cantidad: number;
  fecha: Date;
  usuario: string;
  notas?: string;
}

@Component({
  selector: 'app-secretaria-inventario',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './inventario.component.html',
  styleUrl: './inventario.component.css'
})
export class SecretariaInventarioComponent implements OnInit {
  private readonly adminService = inject(AdminService);
  private readonly modalService = inject(ModalService);

  productos: Producto[] = [];
  productosFiltrados: Producto[] = [];
  loading = true;

  tabActivo: 'stock' | 'movimientos' | 'alertas' = 'stock';
  filtro = '';
  filtroEstado = '';
  filtroCategoria = '';
  filtroTipoMovimiento = '';

  ultimosMovimientos: MovimientoInventario[] = [];
  loadingMovimientos = false;
  errorMovimientos = false;
  eliminandoId: number | null = null;
  soloHoy = false;
  imagenesConError = new Set<number>();
  private readonly STORAGE_TAB = 'secretariaInventarioTab';
  private readonly STORAGE_SOLO_HOY = 'secretariaInventarioSoloHoy';

  get totalUnidades(): number {
    return this.productos.reduce((sum, p) => sum + p.stock, 0);
  }
  get productosOk(): number {
    return this.productos.filter(p => p.stock > p.stock_minimo).length;
  }
  get productosStockBajo(): number {
    return this.productos.filter(p => p.stock > 0 && p.stock <= p.stock_minimo).length;
  }
  get productosAgotados(): number {
    return this.productos.filter(p => p.stock === 0).length;
  }
  get alertasActivas(): number {
    return this.productosStockBajo + this.productosAgotados;
  }
  get categorias(): string[] {
    const cats = new Set(this.productos.map(p => p.categoria || '').filter(Boolean));
    return Array.from(cats).sort((a, b) => a.localeCompare(b));
  }
  get productosConAlertas(): Producto[] {
    return this.productos.filter(p => p.stock === 0 || p.stock <= p.stock_minimo);
  }
  get movimientosFiltrados(): MovimientoInventario[] {
    if (!this.filtroTipoMovimiento) return this.ultimosMovimientos;
    return this.ultimosMovimientos.filter(m => m.tipo === this.filtroTipoMovimiento);
  }
  get productosAlertasFiltrados(): Producto[] {
    return this.productosConAlertas.filter(p => {
      const matchNombre = !this.filtro || p.nombre.toLowerCase().includes(this.filtro.toLowerCase());
      const matchCategoria = !this.filtroCategoria || (p.categoria || '') === this.filtroCategoria;
      let matchEstado = true;
      if (this.filtroEstado === 'normal') matchEstado = p.stock > p.stock_minimo;
      else if (this.filtroEstado === 'bajo') matchEstado = p.stock > 0 && p.stock <= p.stock_minimo;
      else if (this.filtroEstado === 'critico') matchEstado = p.stock > 0 && p.stock <= p.stock_minimo / 2;
      else if (this.filtroEstado === 'agotado') matchEstado = p.stock === 0;
      return matchNombre && matchCategoria && matchEstado;
    });
  }

  ngOnInit(): void {
    const tab = sessionStorage.getItem(this.STORAGE_TAB);
    if (tab === 'stock' || tab === 'movimientos' || tab === 'alertas') this.tabActivo = tab;
    const hoy = sessionStorage.getItem(this.STORAGE_SOLO_HOY);
    if (hoy !== null) this.soloHoy = hoy === 'true';
    const boot = this.adminService.getProductosActivosBootstrap();
    if (boot.length > 0) {
      this.productos = boot;
      this.imagenesConError.clear();
      this.filtrarProductos();
      this.loading = false;
    }
    this.cargarProductos();
    this.cargarMovimientos();
  }

  private guardarPreferencias(): void {
    sessionStorage.setItem(this.STORAGE_TAB, this.tabActivo);
    sessionStorage.setItem(this.STORAGE_SOLO_HOY, String(this.soloHoy));
  }

  cargarProductos(): void {
    this.loading = this.productos.length === 0;
    this.adminService.getProductos(true).subscribe({
      next: (response) => {
        this.loading = false;
        if (response.ok) {
          this.productos = response.productos ?? [];
          this.imagenesConError.clear();
          this.filtrarProductos();
        }
      },
      error: () => {
        this.loading = false;
        this.modalService.showError('Error al cargar inventario');
      }
    });
  }

  cargarMovimientos(): void {
    this.loadingMovimientos = true;
    this.errorMovimientos = false;
    this.adminService.getMovimientosInventario(100, this.soloHoy).subscribe({
      next: (response) => {
        this.loadingMovimientos = false;
        if (response.ok && response.movimientos) {
          this.ultimosMovimientos = response.movimientos.map(m => ({
            tipo: m.tipo as 'entrada' | 'salida' | 'ajuste',
            producto: m.producto,
            cantidad: m.cantidad,
            fecha: m.fecha ? new Date(m.fecha) : new Date(),
            usuario: m.usuario,
            notas: m.notas || ''
          }));
        } else {
          this.ultimosMovimientos = [];
        }
      },
      error: () => {
        this.loadingMovimientos = false;
        this.errorMovimientos = true;
        this.modalService.showError('Error al cargar movimientos');
      }
    });
  }

  filtrarProductos(): void {
    this.productosFiltrados = this.productos.filter(p => {
      const matchNombre = !this.filtro || p.nombre.toLowerCase().includes(this.filtro.toLowerCase());
      const matchCategoria = !this.filtroCategoria || (p.categoria || '') === this.filtroCategoria;
      let matchEstado = true;
      if (this.filtroEstado === 'normal') matchEstado = p.stock > p.stock_minimo;
      else if (this.filtroEstado === 'bajo') matchEstado = p.stock > 0 && p.stock <= p.stock_minimo && p.stock > p.stock_minimo / 2;
      else if (this.filtroEstado === 'critico') matchEstado = p.stock > 0 && p.stock <= p.stock_minimo / 2;
      else if (this.filtroEstado === 'agotado') matchEstado = p.stock === 0;
      return matchNombre && matchCategoria && matchEstado;
    });
  }

  setTab(tab: 'stock' | 'movimientos' | 'alertas'): void {
    this.tabActivo = tab;
    this.guardarPreferencias();
    if (tab === 'movimientos') this.cargarMovimientos();
  }

  setSoloHoy(hoy: boolean): void {
    this.soloHoy = hoy;
    this.guardarPreferencias();
    this.cargarMovimientos();
  }

  exportarCSV(): void {
    const headers = ['Producto', 'Categoría', 'Stock Actual', 'Stock Mínimo', 'Estado'];
    const rows = this.productosFiltrados.map(p => [p.nombre, p.categoria || '', p.stock, p.stock_minimo, this.getEstadoStock(p)]);
    const csv = [headers.join(','), ...rows.map(r => r.map(c => `"${c}"`).join(','))].join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `inventario-secretaria-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.modalService.showSuccess('Exportado correctamente');
  }

  exportarMovimientosCSV(): void {
    const movimientos = this.movimientosFiltrados;
    if (!movimientos.length) {
      this.modalService.showError('No hay movimientos para exportar');
      return;
    }
    const headers = ['Tipo', 'Producto', 'Cantidad', 'Fecha', 'Usuario', 'Notas'];
    const rows = movimientos.map(m => [
      this.getMovimientoLabel(m.tipo),
      m.producto,
      m.tipo === 'salida' ? -Math.abs(m.cantidad) : Math.abs(m.cantidad),
      m.fecha ? new Date(m.fecha).toLocaleString('es-MX') : '',
      m.usuario || '',
      m.notas || '',
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.map(c => `"${String(c ?? '').replaceAll('"', '""')}"`).join(','))].join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const scope = this.soloHoy ? 'hoy' : 'historial';
    a.download = `inventario-movimientos-secretaria-${scope}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.modalService.showSuccess('Movimientos exportados correctamente');
  }

  async exportarMovimientosXLSX(): Promise<void> {
    const movimientos = this.movimientosFiltrados;
    if (!movimientos.length) {
      this.modalService.showError('No hay movimientos para exportar');
      return;
    }
    const rows = movimientos.map(m => ({
      Tipo: this.getMovimientoLabel(m.tipo),
      Producto: m.producto,
      Cantidad: m.tipo === 'salida' ? -Math.abs(m.cantidad) : Math.abs(m.cantidad),
      Fecha: m.fecha ? new Date(m.fecha).toLocaleString('es-MX') : '',
      Usuario: m.usuario || '',
      Notas: m.notas || '',
    }));
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(rows);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Movimientos');
      const scope = this.soloHoy ? 'hoy' : 'historial';
      XLSX.writeFile(workbook, `inventario-movimientos-secretaria-${scope}-${new Date().toISOString().slice(0, 10)}.xlsx`);
      this.modalService.showSuccess('Movimientos exportados en Excel');
    } catch {
      this.modalService.showError('No se pudo exportar a Excel');
    }
  }

  getEstadoStock(producto: Producto): string {
    if (producto.stock === 0) return 'Agotado';
    if (producto.stock <= producto.stock_minimo / 2) return 'Crítico';
    if (producto.stock <= producto.stock_minimo) return 'Bajo';
    return 'Normal';
  }
  getBadgeClass(producto: Producto): string {
    if (producto.stock === 0) return 'badge-error';
    if (producto.stock <= producto.stock_minimo / 2) return 'badge-error';
    if (producto.stock <= producto.stock_minimo) return 'badge-warning';
    return 'badge-success';
  }
  getColorStock(producto: Producto): string {
    if (producto.stock === 0) return 'var(--color-error)';
    if (producto.stock <= producto.stock_minimo) return 'var(--color-warning)';
    return 'inherit';
  }
  getMovimientoIconClass(tipo: MovimientoInventario['tipo']): string {
    if (tipo === 'entrada') return 'mov-icon mov-icon-entrada';
    if (tipo === 'salida') return 'mov-icon mov-icon-salida';
    return 'mov-icon mov-icon-ajuste';
  }
  getMovimientoLabel(tipo: MovimientoInventario['tipo']): string {
    if (tipo === 'entrada') return 'Entrada';
    if (tipo === 'salida') return 'Salida';
    return 'Ajuste';
  }

  ajustarStockExacto(producto: Producto, event?: Event): void {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const valor = prompt(`Stock actual de "${producto.nombre}": ${producto.stock}\n\nIngresa el nuevo stock exacto (0 o más):`, String(producto.stock));
    if (valor === null) return;
    const nuevoStock = Number(valor);
    if (!Number.isFinite(nuevoStock) || !Number.isInteger(nuevoStock) || nuevoStock < 0) {
      this.modalService.showError('Ingresa un número entero mayor o igual a 0');
      return;
    }
    const nota = prompt('Escribe el motivo del ajuste (obligatorio):', '');
    if (nota === null) return;
    if (!nota.trim()) {
      this.modalService.showError('Para secretaría, la nota del ajuste es obligatoria.');
      return;
    }

    this.adminService.actualizarStock(producto.id, nuevoStock, 'establecer', nota.trim()).subscribe({
      next: (response) => {
        if (response?.ok) {
          this.modalService.showSuccess(`Stock actualizado a ${response.stock_actual}`);
          this.cargarProductos();
          this.cargarMovimientos();
        } else {
          this.modalService.showError(response?.error || 'No se pudo ajustar el stock');
        }
      },
      error: (err: { error?: { error?: string; detail?: string } }) => {
        this.modalService.showError(err?.error?.error || err?.error?.detail || 'No se pudo ajustar el stock');
      }
    });
  }

  tieneImagenValida(producto: Producto): boolean {
    return !!producto.imagen_url && !this.imagenesConError.has(producto.id);
  }
  onImagenError(productoId: number): void {
    this.imagenesConError.add(productoId);
  }
}
