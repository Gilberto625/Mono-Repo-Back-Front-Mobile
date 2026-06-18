import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../../shared/breadcrumb/breadcrumb.component';
import { AdminService } from '../../../../services/admin.service';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../../../environments/environment';

const TITULOS: Record<string, string> = {
  'ventas-dia': 'Ventas del Día',
  'ventas-semana': 'Ventas Semanales',
  'ventas-mes': 'Ventas del Mes',
  'servicios-populares': 'Servicios Más Populares',
  'citas': 'Reporte de Citas',
  'horarios': 'Ocupación por Horario',
  'productos-vendidos': 'Productos Más Vendidos',
  'inventario': 'Movimientos de Inventario'
};

/** Tipos de reporte que permiten filtrar por período (día, semana, mes). */
const TIPOS_CON_PERIODO = [
  'ventas-dia', 'ventas-semana', 'ventas-mes',
  'servicios-populares', 'citas', 'horarios', 'productos-vendidos', 'inventario'
];

/** Fecha de hoy en zona local, formato YYYY-MM-DD (para que el admin vea su día real). */
function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfWeek(d: Date): Date {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  return date;
}

function endOfWeek(d: Date): Date {
  const start = startOfWeek(d);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return end;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

/** Fecha en zona local YYYY-MM-DD (evita desfase por UTC). */
function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

@Component({
  selector: 'app-reporte-vista',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './reporte-vista.component.html',
  styleUrl: './reporte-vista.component.css'
})
export class ReporteVistaComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private adminService = inject(AdminService);

  tipo = this.route.snapshot.queryParamMap.get('tipo') ?? '';
  titulo = TITULOS[this.tipo] ?? 'Reporte';

  loading = true;
  error = false;
  data: any = null;

  /** Filtro de período: solo visible para tipos que lo soportan */
  mostrarFiltroPeriodo = false;
  periodoSelect: 'dia' | 'semana' | 'mes' = 'dia';
  fechaDesde = '';
  fechaHasta = '';
  exportandoPDF = false;
  exportandoExcel = false;
  exportandoCSV = false;
  copiandoResumen = false;
  nombreEmpresa = 'Barberia';
  logoUrl = '';
  logoTexto = '';
  logoTipo = '';
  logoUrlNormalizado = '';
  private logoDataUrl = '';
  productosVendidosDetalle: Array<{ fecha: string; hora: string; cliente_nombre: string; producto_nombre: string; unidades: number; total: number }> = [];
  loadingProductosVendidos = false;

  ngOnInit(): void {
    this.cargarDatosEmpresa();
    if (this.tipo) {
      this.mostrarFiltroPeriodo = TIPOS_CON_PERIODO.includes(this.tipo);
      this.inicializarFechasPorTipo();
      this.cargarReporte();
    } else {
      this.loading = false;
    }
  }

  private cargarDatosEmpresa(): void {
    this.adminService.getConfiguracion().subscribe({
      next: (res) => {
        this.aplicarMarcaDesdeRespuestaConfiguracion(res);
      }
    });
  }

  /** Inicializa desde/hasta según tipo de reporte (día, semana o mes por defecto). */
  inicializarFechasPorTipo(): void {
    const hoy = new Date();
    if (this.tipo === 'ventas-dia') {
      this.periodoSelect = 'dia';
      this.fechaDesde = todayISO();
      this.fechaHasta = this.fechaDesde;
    } else if (this.tipo === 'ventas-semana') {
      this.periodoSelect = 'semana';
      this.fechaDesde = toISO(startOfWeek(hoy));
      this.fechaHasta = toISO(endOfWeek(hoy));
    } else {
      this.periodoSelect = 'mes';
      this.fechaDesde = toISO(startOfMonth(hoy));
      this.fechaHasta = toISO(endOfMonth(hoy));
    }
  }

  /** Al cambiar el selector de período, actualiza Desde/Hasta. */
  onPeriodoChange(): void {
    const d = this.fechaDesde ? new Date(this.fechaDesde + 'T12:00:00') : new Date();
    if (this.periodoSelect === 'dia') {
      this.fechaDesde = toISO(d);
      this.fechaHasta = this.fechaDesde;
    } else if (this.periodoSelect === 'semana') {
      this.fechaDesde = toISO(startOfWeek(d));
      this.fechaHasta = toISO(endOfWeek(d));
    } else {
      this.fechaDesde = toISO(startOfMonth(d));
      this.fechaHasta = toISO(endOfMonth(d));
    }
  }

  /** Al cambiar Desde, ajustar Hasta si es necesario (ej. día: hasta = desde). */
  onDesdeChange(): void {
    if (this.periodoSelect === 'dia') {
      this.fechaHasta = this.fechaDesde;
    } else if (this.fechaHasta && this.fechaDesde && this.fechaHasta < this.fechaDesde) {
      this.fechaHasta = this.fechaDesde;
    }
  }

  aplicarFiltro(): void {
    if (!this.fechaDesde || !this.fechaHasta) return;
    if (this.fechaHasta < this.fechaDesde) this.fechaHasta = this.fechaDesde;
    this.cargarReporte();
  }

  cargarReporte(): void {
    const comp = this;
    comp.loading = true;
    comp.error = false;
    const desde = comp.mostrarFiltroPeriodo && comp.fechaDesde ? comp.fechaDesde : undefined;
    const hasta = comp.mostrarFiltroPeriodo && comp.fechaHasta ? comp.fechaHasta : undefined;
    this.adminService.getReportes(this.tipo, undefined, desde, hasta).subscribe({
      next(res: { ok?: boolean }) {
        comp.loading = false;
        if (res?.ok) {
          const esReporteVentas = comp.tipo === 'ventas-dia' || comp.tipo === 'ventas-semana' || comp.tipo === 'ventas-mes';
          if (esReporteVentas) {
            const detalleNormalizado = Array.isArray((res as any)?.detalle)
              ? (res as any).detalle.map((f: any) => ({
                  fecha: f?.fecha || '-',
                  hora: f?.hora || '-',
                  cliente_nombre: f?.cliente_nombre || '-',
                  servicio_nombre: f?.servicio_nombre || '-',
                  precio_total: Number(f?.precio_total) || 0
                }))
              : [];
            comp.data = {
              ...(res as any),
              detalle: detalleNormalizado
            };
            const dp = (res as any)?.detalle_productos;
            if (Array.isArray(dp)) {
              comp.productosVendidosDetalle = dp.map((f: any) => ({
                fecha: f.fecha || '-',
                hora: f.hora || '-',
                cliente_nombre: f.cliente_nombre || '-',
                producto_nombre: f.producto_nombre || '-',
                unidades: Number(f.unidades) || 0,
                total: Number(f.total) || 0
              }));
              comp.loadingProductosVendidos = false;
            } else {
              comp.cargarProductosVendidosDetalle();
            }
          } else {
            comp.data = res;
            comp.productosVendidosDetalle = [];
          }
        } else {
          comp.error = true;
          comp.productosVendidosDetalle = [];
        }
      },
      error() {
        comp.loading = false;
        comp.error = true;
        comp.productosVendidosDetalle = [];
      }
    });
  }

  private cargarProductosVendidosDetalle(): void {
    const desde = this.fechaDesde || undefined;
    const hasta = this.fechaHasta || undefined;
    this.loadingProductosVendidos = true;
    this.adminService.getReportes('productos-vendidos', undefined, desde, hasta).subscribe({
      next: (res: any) => {
        this.loadingProductosVendidos = false;
        const detalle = res?.detalle || [];
        this.productosVendidosDetalle = detalle.map((f: any) => ({
          fecha: f.fecha || '-',
          hora: f.hora || '-',
          cliente_nombre: f.cliente_nombre || '-',
          producto_nombre: f.producto_nombre || '-',
          unidades: Number(f.unidades) || 0,
          total: Number(f.total) || 0
        }));
      },
      error: () => {
        this.loadingProductosVendidos = false;
        this.productosVendidosDetalle = [];
      }
    });
  }

  formatMonto(value: number): string {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
  }

  getVariacionClase(porcentaje: number): string {
    return porcentaje >= 0 ? 'text-success' : 'text-error';
  }

  /** Etiqueta legible del estado de cita */
  estadoLabel(estado: string): string {
    const labels: Record<string, string> = {
      'pendiente': 'Pendiente',
      'confirmada': 'Confirmada',
      'en_curso': 'En curso',
      'completada': 'Completada',
      'cancelada': 'Cancelada',
      'no_asistio': 'No asistió'
    };
    return labels[estado] ?? estado;
  }

  /** Etiqueta del período para el subtítulo */
  getPeriodoLabel(): string {
    if (!this.data?.periodo) return '';
    const p = this.data.periodo;
    if (p.hoy) return p.hoy;
    if (p.inicio && p.fin) return `${p.inicio} – ${p.fin}`;
    return p.inicio || '';
  }

  /** Barras para el gráfico: por hora (día) o por fecha (semana/mes). { label, value }[] */
  getBarrasVentas(): { label: string; value: number }[] {
    const detalle = this.data?.detalle as Array<{ fecha?: string; hora?: string; precio_total?: number }> | undefined;
    if (!detalle?.length) return [];

    if (this.tipo === 'ventas-dia') {
      const porHora: Record<number, number> = {};
      for (let h = 0; h < 24; h++) porHora[h] = 0;
      for (const d of detalle) {
        const hora = d.hora ? parseInt(String(d.hora).split(':')[0], 10) : 0;
        if (!isNaN(hora)) porHora[hora] = (porHora[hora] || 0) + (d.precio_total ?? 0);
      }
      return Array.from({ length: 24 }, (_, i) => ({
        label: `${i}:00`,
        value: porHora[i] ?? 0
      }));
    }

    const porFecha: Record<string, number> = {};
    for (const d of detalle) {
      const f = d.fecha ?? '';
      porFecha[f] = (porFecha[f] || 0) + (d.precio_total ?? 0);
    }
    const diasOrden = Object.keys(porFecha).sort();
    const nombresDia = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    return diasOrden.map(f => {
      const d = new Date(f + 'T12:00:00');
      const nombre = this.tipo === 'ventas-semana' ? nombresDia[d.getDay()] : f;
      return { label: nombre, value: porFecha[f] ?? 0 };
    });
  }

  /** Altura máxima de las barras (para escala %) */
  getBarMaxHeight(): number {
    const barras = this.getBarrasVentas();
    if (!barras.length) return 100;
    const max = Math.max(...barras.map(b => b.value));
    return max > 0 ? max : 100;
  }

  get totalDetalle(): number {
    const detalle = this.data?.detalle as Array<{ precio_total?: number }> | undefined;
    if (!detalle?.length) return 0;
    return detalle.reduce((sum, d) => sum + (d.precio_total ?? 0), 0);
  }

  get totalProductosDetalle(): number {
    if (!this.productosVendidosDetalle.length) return 0;
    return this.productosVendidosDetalle.reduce((sum, p) => sum + (p.total || 0), 0);
  }

  get totalUnidadesProductosDetalle(): number {
    if (!this.productosVendidosDetalle.length) return 0;
    return this.productosVendidosDetalle.reduce((sum, p) => sum + (p.unidades || 0), 0);
  }

  get totalProductosReporte(): number {
    const detalle = this.data?.detalle as Array<{ total?: number }> | undefined;
    if (!detalle?.length) return 0;
    return detalle.reduce((sum, p) => sum + (Number(p.total) || 0), 0);
  }

  get totalUnidadesProductosReporte(): number {
    const detalle = this.data?.detalle as Array<{ unidades?: number }> | undefined;
    if (!detalle?.length) return 0;
    return detalle.reduce((sum, p) => sum + (Number(p.unidades) || 0), 0);
  }

  get cantidadTransacciones(): number {
    return (this.data?.detalle?.length as number) ?? 0;
  }

  get promedioTransaccion(): number {
    const n = this.cantidadTransacciones;
    return n > 0 ? this.totalDetalle / n : 0;
  }

  /** Datos para la gráfica pastel: Distribución de Ingresos (Servicios vs Productos). Interactúa con las fechas del filtro. */
  get distribucionIngresos(): { servicios: number; productos: number; serviciosPct: number; productosPct: number; total: number } {
    const servicios = (this.data?.servicios_total ?? 0) as number;
    const productos = (this.data?.productos_total ?? 0) as number;
    const total = servicios + productos;
    if (total <= 0) {
      return { servicios: 0, productos: 0, serviciosPct: 0, productosPct: 0, total: 0 };
    }
    const serviciosPct = Math.round((servicios / total) * 100);
    const productosPct = 100 - serviciosPct;
    return { servicios, productos, serviciosPct, productosPct, total };
  }

  /** Porcentaje de Servicios (0–100) para el conic-gradient de la gráfica pastel. */
  get pieServiciosPct(): number {
    return this.distribucionIngresos.serviciosPct;
  }

  get totalVentasDescuadre(): number {
    if (!(this.tipo === 'ventas-dia' || this.tipo === 'ventas-semana' || this.tipo === 'ventas-mes')) return 0;
    const total = Number(this.data?.total || 0);
    const suma = Number(this.data?.servicios_total || 0) + Number(this.data?.productos_total || 0);
    return Number((total - suma).toFixed(2));
  }

  private generarGraficaDistribucionDataUrl(size = 220): string {
    if (typeof document === 'undefined') return '';
    const total = this.distribucionIngresos.total;
    if (total <= 0) return '';

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';

    const cx = size / 2;
    const cy = size / 2;
    const r = Math.max(10, Math.floor(size * 0.42));
    const servicios = Number(this.distribucionIngresos.servicios) || 0;
    const productos = Number(this.distribucionIngresos.productos) || 0;
    const anguloServicios = (servicios / (servicios + productos)) * Math.PI * 2;

    ctx.clearRect(0, 0, size, size);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + anguloServicios);
    ctx.closePath();
    ctx.fillStyle = '#e5e7eb';
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, -Math.PI / 2 + anguloServicios, -Math.PI / 2 + Math.PI * 2);
    ctx.closePath();
    ctx.fillStyle = '#2dd4bf';
    ctx.fill();

    return canvas.toDataURL('image/png');
  }

  async exportarPDF(): Promise<void> {
    if (!this.data || this.loading || this.error || this.exportandoPDF) return;
    this.exportandoPDF = true;
    try {
      await this.sincronizarMarcaDesdeConfiguracion();
      const { jsPDF } = await import('jspdf');
      const autoTableModule = await import('jspdf-autotable');
      const autoTable = autoTableModule.default;
      const doc = new jsPDF({ unit: 'pt', format: 'a4' });
      let y = 40;

      const logo = await this.obtenerLogoDataUrl();
      const logoTexto = this.logoTexto || this.nombreEmpresa || 'Barberia';
      if (logo) {
        const format = logo.includes('image/png') ? 'PNG' : 'JPEG';
        doc.addImage(logo, format, 40, 28, 52, 52);
      } else {
        // Fallback: si no hay imagen, renderiza logo en texto desde configuración.
        doc.setDrawColor(220);
        doc.setFillColor(245, 245, 245);
        doc.roundedRect(40, 28, 52, 52, 8, 8, 'FD');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(14);
        doc.setTextColor(55);
        const marca = (logoTexto || 'BAR').substring(0, 3).toUpperCase();
        doc.text(marca, 66, 60, { align: 'center' });
        doc.setFont('helvetica', 'normal');
      }

      doc.setFontSize(16);
      doc.text(this.nombreEmpresa, 102, 46);
      doc.setFontSize(12);
      doc.text(this.titulo, 102, 64);
      doc.setFontSize(10);
      doc.setTextColor(100);
      doc.text(`Fecha: ${this.formatearFechaHora(new Date())}`, 102, 80);
      doc.text(`Periodo: ${this.getPeriodoLabel() || 'N/A'}`, 102, 94);
      y = 120;

      if (this.tipo === 'ventas-dia' || this.tipo === 'ventas-semana' || this.tipo === 'ventas-mes') {
        const chart = this.generarGraficaDistribucionDataUrl(220);
        doc.setFontSize(12);
        doc.setTextColor(40);
        doc.text('Distribucion de ingresos', 40, y);
        if (chart) {
          doc.addImage(chart, 'PNG', 40, y + 8, 110, 110);
        }
        // Leyenda con marcadores de color para identificar cada segmento del pastel.
        doc.setFillColor(229, 231, 235);
        doc.circle(170, y + 36, 4, 'F');
        doc.setFillColor(45, 212, 191);
        doc.circle(170, y + 56, 4, 'F');
        doc.setFontSize(10);
        doc.setTextColor(60);
        doc.text(`Servicios: ${this.formatMonto(this.distribucionIngresos.servicios)} (${this.distribucionIngresos.serviciosPct}%)`, 180, y + 40);
        doc.text(`Productos: ${this.formatMonto(this.distribucionIngresos.productos)} (${this.distribucionIngresos.productosPct}%)`, 180, y + 60);
        y += 132;
      }

      const { headers, rows } = this.getDataExportable();
      if (rows.length === 0) {
        doc.setFontSize(11);
        doc.text('No hay datos para exportar en este periodo.', 40, y);
      } else {
        const bodyRows = rows.map(r => r.map(v => String(v)));
        if (this.tipo === 'ventas-dia' || this.tipo === 'ventas-semana' || this.tipo === 'ventas-mes') {
          bodyRows.push(['TOTAL', '—', '—', '—', this.formatMonto(this.totalDetalle)]);
        }
        doc.setFontSize(12);
        doc.setTextColor(40);
        doc.text(this.getTituloTablaPrincipal(), 40, y - 8);
        autoTable(doc, {
          startY: y,
          head: [headers],
          body: bodyRows,
          styles: { fontSize: 9, cellPadding: 6 },
          headStyles: { fillColor: [32, 32, 32], textColor: [255, 255, 255] },
          alternateRowStyles: { fillColor: [245, 245, 245] }
        });
      }

      // En reportes de ventas, anexar también el detalle de productos vendidos.
      if (this.tipo === 'ventas-dia' || this.tipo === 'ventas-semana' || this.tipo === 'ventas-mes') {
        const productosRows = await this.getProductosVendidosParaExport();
        const finalY = ((doc as any).lastAutoTable?.finalY || y) + 26;
        doc.setFontSize(12);
        doc.setTextColor(40);
        doc.text('Detalle de productos vendidos', 40, finalY);

        if (productosRows.length > 0) {
          const totalUnidades = productosRows.reduce((acc, r) => acc + (Number(r[4]) || 0), 0);
          const totalMonto = this.formatMonto(
            productosRows.reduce((acc, r) => acc + (typeof r[5] === 'number' ? Number(r[5]) : 0), 0)
          );
          autoTable(doc, {
            startY: finalY + 8,
            head: [['Fecha', 'Hora', 'Cliente', 'Producto', 'Unidades vendidas', 'Total vendido']],
            body: [
              ...productosRows.map(r => [String(r[0]), String(r[1]), String(r[2]), String(r[3]), String(r[4]), String(r[5] ?? '')]),
              ['TOTAL', '—', '—', '—', String(totalUnidades), totalMonto]
            ],
            styles: { fontSize: 9, cellPadding: 6 },
            headStyles: { fillColor: [32, 32, 32], textColor: [255, 255, 255] },
            alternateRowStyles: { fillColor: [245, 245, 245] }
          });
        } else {
          doc.setFontSize(10);
          doc.setTextColor(100);
          doc.text('Sin productos vendidos en este periodo.', 40, finalY + 24);
        }

        // Total general al final del PDF (servicios + productos).
        this.agregarTotalFinalPDF(
          doc,
          'TOTAL FINAL',
          Number(this.data?.total || 0)
        );
      }

      if (this.tipo === 'inventario') {
        const topProductos = Array.isArray(this.data?.top_productos) ? this.data.top_productos : [];
        const movimientosRecientes = Array.isArray(this.data?.detalle_reciente) ? this.data.detalle_reciente : [];
        const existenciasActuales = Array.isArray(this.data?.existencias) ? this.data.existencias : [];
        const yBase = ((doc as any).lastAutoTable?.finalY || y) + 26;

        doc.setFontSize(12);
        doc.setTextColor(40);
        doc.text('Top productos con mayor movimiento', 40, yBase);
        if (topProductos.length > 0) {
          autoTable(doc, {
            startY: yBase + 8,
            head: [['Producto', 'Tipo', 'Unidades movidas']],
            body: topProductos.map((r: any) => [
              String(r?.producto || 'Producto'),
              String(r?.tipo || 'movimiento'),
              String(Number(r?.total_unidades) || 0)
            ]),
            styles: { fontSize: 9, cellPadding: 6 },
            headStyles: { fillColor: [32, 32, 32], textColor: [255, 255, 255] },
            alternateRowStyles: { fillColor: [245, 245, 245] }
          });
        } else {
          doc.setFontSize(10);
          doc.setTextColor(100);
          doc.text('Sin movimientos de inventario en este período.', 40, yBase + 24);
        }

        const yMov = ((doc as any).lastAutoTable?.finalY || (yBase + 24)) + 24;
        doc.setFontSize(12);
        doc.setTextColor(40);
        doc.text('Bitácora de movimientos recientes', 40, yMov);
        if (movimientosRecientes.length > 0) {
          autoTable(doc, {
            startY: yMov + 8,
            head: [['Fecha', 'Hora', 'Producto', 'Tipo', 'Cantidad', 'Stock ant.', 'Stock post.']],
            body: movimientosRecientes.slice(0, 80).map((r: any) => [
              String(r?.fecha || '-'),
              String(r?.hora || '-'),
              String(r?.producto || 'Producto'),
              String(r?.tipo || 'movimiento'),
              String(Number(r?.cantidad) || 0),
              String(Number(r?.stock_anterior) || 0),
              String(Number(r?.stock_posterior) || 0)
            ]),
            styles: { fontSize: 8, cellPadding: 5 },
            headStyles: { fillColor: [32, 32, 32], textColor: [255, 255, 255] },
            alternateRowStyles: { fillColor: [245, 245, 245] }
          });
        } else {
          doc.setFontSize(10);
          doc.setTextColor(100);
          doc.text('Sin bitácora para mostrar.', 40, yMov + 24);
        }

        const yExist = ((doc as any).lastAutoTable?.finalY || (yMov + 24)) + 24;
        doc.setFontSize(12);
        doc.setTextColor(40);
        doc.text('Estado actual de existencias', 40, yExist);
        if (existenciasActuales.length > 0) {
          autoTable(doc, {
            startY: yExist + 8,
            head: [['Producto', 'Stock actual', 'Stock minimo', 'Precio venta', 'Valor inventario']],
            body: existenciasActuales.slice(0, 120).map((r: any) => [
              String(r?.producto || 'Producto'),
              String(Number(r?.stock_actual) || 0),
              String(Number(r?.stock_minimo) || 0),
              this.formatMonto(Number(r?.precio_venta) || 0),
              this.formatMonto(Number(r?.valor_inventario) || 0)
            ]),
            styles: { fontSize: 8, cellPadding: 5 },
            headStyles: { fillColor: [32, 32, 32], textColor: [255, 255, 255] },
            alternateRowStyles: { fillColor: [245, 245, 245] }
          });
        } else {
          doc.setFontSize(10);
          doc.setTextColor(100);
          doc.text('Sin existencias para mostrar.', 40, yExist + 24);
        }
      }

      doc.save(`reporte-${this.tipo || 'general'}-${todayISO()}.pdf`);
    } finally {
      this.exportandoPDF = false;
    }
  }

  private async sincronizarMarcaDesdeConfiguracion(): Promise<void> {
    try {
      const res: any = await firstValueFrom(this.adminService.getConfiguracion());
      this.aplicarMarcaDesdeRespuestaConfiguracion(res, true);
    } catch {
      // En caso de error, se usa la marca ya cargada en memoria.
    }
  }

  private aplicarMarcaDesdeRespuestaConfiguracion(res: any, resetLogoCache = false): void {
    // Compatibilidad: algunos endpoints devuelven { configuracion: {...} } y otros plano.
    const c = (res && typeof res === 'object')
      ? ((res.configuracion && typeof res.configuracion === 'object') ? res.configuracion : res)
      : {};
    if (!c || typeof c !== 'object') return;

    const nombre = String(c.nombre_negocio || '').trim();
    if (nombre) this.nombreEmpresa = nombre;

    const logoUrl = String(c.logo_url || '').trim();
    if (logoUrl) this.logoUrl = logoUrl;

    const parte1 = String(c.logo_texto_parte1 || '').trim();
    const parte2 = String(c.logo_texto_parte2 || '').trim();
    const logoTextoPlano = String(c.logo_texto || '').trim();
    const logoTextoCompuesto = [parte1, parte2].filter(Boolean).join(' ').trim();
    this.logoTexto = logoTextoCompuesto || logoTextoPlano || this.logoTexto;
    this.logoTipo = String(c.logo_tipo || this.logoTipo || '').trim().toLowerCase();
    this.logoUrlNormalizado = this.normalizarLogoUrl(this.logoUrl);

    if (resetLogoCache) {
      // Forzar lectura de logo actualizado al exportar PDF.
      this.logoDataUrl = '';
    }
  }

  async exportarExcel(): Promise<void> {
    if (!this.data || this.loading || this.error || this.exportandoExcel) return;
    this.exportandoExcel = true;
    try {
      const XLSX = await import('xlsx');
      const { headers, rows } = this.getDataExportable();
      const meta = [
        ['Empresa', this.nombreEmpresa],
        ['Reporte', this.titulo],
        ['Fecha de exportacion', this.formatearFechaHora(new Date())],
        ['Periodo', this.getPeriodoLabel() || 'N/A'],
        []
      ];
      const wsData: (string | number)[][] = [...meta, headers, ...rows];
      if (this.tipo === 'ventas-dia' || this.tipo === 'ventas-semana' || this.tipo === 'ventas-mes') {
        const productosRows = await this.getProductosVendidosParaExport();
        wsData.push([]);
        wsData.push(['Detalle de productos vendidos']);
        wsData.push(['Fecha', 'Hora', 'Cliente', 'Producto', 'Unidades vendidas', 'Total vendido']);
        if (productosRows.length > 0) {
          wsData.push(...productosRows);
          const totalUnidades = productosRows.reduce((acc, r) => acc + (Number(r[4]) || 0), 0);
          const totalMonto = this.formatMonto(
            productosRows.reduce((acc, r) => acc + (typeof r[5] === 'number' ? Number(r[5]) : 0), 0)
          );
          wsData.push(['TOTAL', '—', '—', '—', totalUnidades, totalMonto]);
        } else {
          wsData.push(['-', '-', '-', 'Sin productos vendidos en este periodo', 0, this.formatMonto(0)]);
        }
      }
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      ws['!cols'] = headers.map(() => ({ wch: 24 }));

      const resumen = this.getResumenExportable();
      const wsResumen = XLSX.utils.aoa_to_sheet([
        ['Empresa', this.nombreEmpresa],
        ['Reporte', this.titulo],
        ['Fecha de exportacion', this.formatearFechaHora(new Date())],
        ['Periodo', this.getPeriodoLabel() || 'N/A'],
        [],
        ['Metrica', 'Valor'],
        ...resumen
      ]);
      wsResumen['!cols'] = [{ wch: 34 }, { wch: 24 }];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Reporte');
      XLSX.utils.book_append_sheet(wb, wsResumen, 'Resumen');
      XLSX.writeFile(wb, `reporte-${this.tipo || 'general'}-${todayISO()}.xlsx`);
    } finally {
      this.exportandoExcel = false;
    }
  }

  async exportarCSV(): Promise<void> {
    if (!this.data || this.loading || this.error || this.exportandoCSV) return;
    this.exportandoCSV = true;
    try {
      const { headers, rows } = this.getDataExportable();
      const lineas: string[] = [];

      lineas.push(this.csvLine(['Empresa', this.nombreEmpresa]));
      lineas.push(this.csvLine(['Reporte', this.titulo]));
      lineas.push(this.csvLine(['Fecha de exportacion', this.formatearFechaHora(new Date())]));
      lineas.push(this.csvLine(['Periodo', this.getPeriodoLabel() || 'N/A']));
      lineas.push('');
      lineas.push(this.csvLine(headers));
      for (const r of rows) lineas.push(this.csvLine(r));

      if (this.tipo === 'ventas-dia' || this.tipo === 'ventas-semana' || this.tipo === 'ventas-mes') {
        lineas.push(this.csvLine(['TOTAL SERVICIOS', '', '', '', this.formatMonto(this.totalDetalle)]));
        lineas.push('');
        lineas.push('Detalle de productos vendidos');
        lineas.push(this.csvLine(['Fecha', 'Hora', 'Cliente', 'Producto', 'Unidades vendidas', 'Total vendido']));
        const productosRows = await this.getProductosVendidosParaExport();
        for (const r of productosRows) {
          lineas.push(this.csvLine([r[0], r[1], r[2], r[3], r[4], this.formatMonto(Number(r[5] || 0))]));
        }
        lineas.push(this.csvLine([
          'TOTAL PRODUCTOS', '', '', '',
          this.totalUnidadesProductosDetalle,
          this.formatMonto(this.totalProductosDetalle)
        ]));
        lineas.push(this.csvLine([
          'TOTAL FINAL', '', '', '', '', this.formatMonto(Number(this.data?.total || 0))
        ]));
      }

      const contenido = '\ufeff' + lineas.join('\n');
      const blob = new Blob([contenido], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `reporte-${this.tipo || 'general'}-${todayISO()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      this.exportandoCSV = false;
    }
  }

  async copiarResumen(): Promise<void> {
    if (!this.data || this.loading || this.error || this.copiandoResumen) return;
    this.copiandoResumen = true;
    try {
      const lineas: string[] = [];
      lineas.push(`${this.nombreEmpresa} - ${this.titulo}`);
      lineas.push(`Periodo: ${this.getPeriodoLabel() || 'N/A'}`);

      if (this.tipo === 'ventas-dia' || this.tipo === 'ventas-semana' || this.tipo === 'ventas-mes') {
        lineas.push(`Total: ${this.formatMonto(Number(this.data?.total || 0))}`);
        lineas.push(`Servicios: ${this.formatMonto(Number(this.data?.servicios_total || 0))}`);
        lineas.push(`Productos: ${this.formatMonto(Number(this.data?.productos_total || 0))}`);
        lineas.push(`Transacciones: ${Number(this.data?.transacciones || this.cantidadTransacciones || 0)}`);
      } else if (this.tipo === 'servicios-populares') {
        lineas.push(`Citas válidas: ${Number(this.data?.total_citas_validas || 0)}`);
        lineas.push(`Anticipos validados: ${this.formatMonto(Number(this.data?.anticipos_validados_total || 0))}`);
        lineas.push(`Servicios listados: ${Number((this.data?.detalle || []).length || 0)}`);
      } else if (this.tipo === 'citas') {
        lineas.push(`Total citas: ${Number(this.data?.total_citas || 0)}`);
        lineas.push(`Tasa asistencia: ${Number(this.data?.tasa_asistencia || 0)}%`);
        lineas.push(`Anticipos validados: ${this.formatMonto(Number(this.data?.anticipos_validados_total || 0))}`);
      } else if (this.tipo === 'horarios') {
        lineas.push(`Citas validadas: ${Number(this.data?.total_citas_validadas || 0)}`);
        lineas.push(`Anticipos validados: ${this.formatMonto(Number(this.data?.anticipos_validados_total || 0))}`);
      }

      const texto = lineas.join('\n');
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(texto);
      } else {
        const ta = document.createElement('textarea');
        ta.value = texto;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      alert('Resumen copiado al portapapeles.');
    } finally {
      this.copiandoResumen = false;
    }
  }

  private getDataExportable(): { headers: string[]; rows: (string | number)[][] } {
    if (!this.data) return { headers: ['Sin datos'], rows: [] };

    if (this.tipo === 'ventas-dia' || this.tipo === 'ventas-semana' || this.tipo === 'ventas-mes') {
      const detalle = this.data.detalle || [];
      return {
        headers: ['Fecha', 'Hora', 'Cliente', 'Servicio', 'Total'],
        rows: detalle.map((f: any) => [f.fecha || '-', f.hora || '-', f.cliente_nombre || '-', f.servicio_nombre || '-', this.formatMonto(Number(f.precio_total) || 0)])
      };
    }

    if (this.tipo === 'servicios-populares') {
      const detalle = this.data.detalle || [];
      return {
        headers: ['Servicio', 'Cantidad', 'Total'],
        rows: detalle.map((f: any) => [f.servicio_nombre || '-', Number(f.cantidad) || 0, this.formatMonto(Number(f.total) || 0)])
      };
    }

    if (this.tipo === 'citas') {
      const porEstado = this.data.por_estado || [];
      return {
        headers: ['Estado', 'Total'],
        rows: porEstado.map((f: any) => [this.estadoLabel(f.estado || ''), Number(f.total) || 0])
      };
    }

    if (this.tipo === 'horarios') {
      const detalle = this.data.detalle || [];
      return {
        headers: ['Hora', 'Cantidad de citas'],
        rows: detalle.map((f: any) => [`${f.hora}:00`, Number(f.cantidad) || 0])
      };
    }

    if (this.tipo === 'productos-vendidos') {
      const detalle = this.data.detalle || [];
      return {
        headers: ['Fecha', 'Hora', 'Cliente', 'Producto', 'Unidades vendidas', 'Total vendido'],
        rows: detalle.map((f: any) => [f.fecha || '-', f.hora || '-', f.cliente_nombre || '-', f.producto_nombre || '-', Number(f.unidades) || 0, this.formatMonto(Number(f.total) || 0)])
      };
    }

    if (this.tipo === 'inventario') {
      const detalle = this.data.detalle || [];
      return {
        headers: ['Tipo', 'Cantidad'],
        rows: detalle.map((f: any) => [f.tipo || '-', Number(f.total) || 0])
      };
    }

    return { headers: ['Sin datos'], rows: [] };
  }

  private async getProductosVendidosParaExport(): Promise<(string | number)[][]> {
    if (!(this.tipo === 'ventas-dia' || this.tipo === 'ventas-semana' || this.tipo === 'ventas-mes')) {
      return [];
    }
    if (this.productosVendidosDetalle.length > 0) {
      return this.productosVendidosDetalle.map(f => [f.fecha, f.hora, f.cliente_nombre, f.producto_nombre, f.unidades, f.total]);
    }
    const desde = this.fechaDesde || undefined;
    const hasta = this.fechaHasta || undefined;
    try {
      const res: any = await firstValueFrom(
        this.adminService.getReportes('productos-vendidos', undefined, desde, hasta)
      );
      const detalle = res?.detalle || [];
      return detalle.map((f: any) => [f.fecha || '-', f.hora || '-', f.cliente_nombre || '-', f.producto_nombre || '-', Number(f.unidades) || 0, Number(f.total) || 0]);
    } catch {
      return [];
    }
  }

  private getResumenExportable(): (string | number)[][] {
    if (!this.data) return [['Sin datos', 'N/A']];

    if (this.tipo === 'ventas-dia' || this.tipo === 'ventas-semana' || this.tipo === 'ventas-mes') {
      return [
        ['Ingresos Totales', this.formatMonto(Number(this.data.total) || 0)],
        ['Ventas por servicios', this.formatMonto(Number(this.data.servicios_total) || 0)],
        ['Ventas por productos', this.formatMonto(Number(this.data.productos_total) || 0)],
        ['Transacciones', Number(this.data.transacciones) || this.cantidadTransacciones],
        ['Variacion', `${Number(this.data.variacion) || 0}%`]
      ];
    }

    if (this.tipo === 'servicios-populares') {
      return [
        ['Servicios listados', (this.data.detalle || []).length],
        ['Total vendido (servicios)', this.formatMonto(Number(this.data.total) || 0)]
      ];
    }

    if (this.tipo === 'citas') {
      return [
        ['Total de citas', Number(this.data.total_citas) || 0],
        ['Tasa de asistencia', `${Number(this.data.tasa_asistencia) || 0}%`]
      ];
    }

    if (this.tipo === 'horarios') {
      const detalle = this.data.detalle || [];
      const total = detalle.reduce((acc: number, f: any) => acc + (Number(f.cantidad) || 0), 0);
      return [
        ['Bloques horarios con actividad', detalle.length],
        ['Total de citas en horarios', total]
      ];
    }

    if (this.tipo === 'productos-vendidos') {
      const detalle = this.data.detalle || [];
      const unidades = detalle.reduce((acc: number, f: any) => acc + (Number(f.unidades) || 0), 0);
      const totalVendido = detalle.reduce((acc: number, f: any) => acc + (Number(f.total) || 0), 0);
      return [
        ['Productos listados', detalle.length],
        ['Unidades vendidas', unidades],
        ['Total vendido en productos', this.formatMonto(totalVendido)]
      ];
    }

    if (this.tipo === 'inventario') {
      return [
        ['Total movimientos', Number(this.data.total_movimientos) || 0],
        ['Productos afectados', Number(this.data.productos_afectados) || 0],
        ['Sin movimientos (periodo)', this.data.sin_movimientos ? 'Si' : 'No'],
        ['Entradas', Number(this.data.entradas) || 0],
        ['Salidas', Number(this.data.salidas) || 0],
        ['Ventas', Number(this.data.ventas) || 0],
        ['Ventas web', Number(this.data.ventas_web) || 0],
        ['Ventas secretaria', Number(this.data.ventas_secretaria) || 0],
        ['Ajustes', Number(this.data.ajustes) || 0],
        ['Balance neto', Number(this.data.balance_neto) || 0],
        ['Existencias actuales', Number(this.data.total_existencias) || 0],
        ['Valor total inventario', this.formatMonto(Number(this.data.valor_total_inventario) || 0)],
        ['Productos con stock bajo', Number(this.data.productos_stock_bajo_actual) || 0],
        ['Devoluciones por cancelacion', Number(this.data.cancelaciones_pedido) || 0]
      ];
    }

    return [['Registros', (this.data.detalle || []).length || 0]];
  }

  private async obtenerLogoDataUrl(): Promise<string> {
    if (this.logoDataUrl) return this.logoDataUrl;
    if (!this.logoUrl) return '';
    const url = this.normalizarLogoUrl(this.logoUrl);
    if (!url) return '';
    if (url.startsWith('data:image/')) {
      this.logoDataUrl = url;
      return this.logoDataUrl;
    }
    try {
      const useCredentials = this.debeEnviarCredencialesLogo(url);
      const res = await fetch(url, { credentials: useCredentials ? 'include' : 'omit' });
      if (!res.ok) return '';
      const blob = await res.blob();
      this.logoDataUrl = await this.blobToDataUrl(blob);
      return this.logoDataUrl;
    } catch {
      return '';
    }
  }

  private normalizarLogoUrl(raw: string): string {
    const txt = String(raw || '').trim();
    if (!txt) return '';
    if (txt.startsWith('data:image/')) return txt;
    if (/^https?:\/\//i.test(txt)) return txt;
    if (txt.startsWith('/')) {
      try {
        const api = new URL(environment.apiUrl);
        return `${api.origin}${txt}`;
      } catch {
        return txt;
      }
    }
    return txt;
  }

  private debeEnviarCredencialesLogo(url: string): boolean {
    try {
      const logo = new URL(url, window.location.origin);
      const api = new URL(environment.apiUrl, window.location.origin);
      // Solo enviar cookies cuando el recurso viene del mismo host del backend/local.
      return logo.origin === api.origin || logo.origin === window.location.origin;
    } catch {
      return false;
    }
  }

  get mostrarLogoImagenEnVista(): boolean {
    return !!this.logoUrlNormalizado;
  }

  get logoTextoEnVista(): string {
    if (this.logoTipo === 'texto' && this.logoTexto) return this.logoTexto;
    if (!this.logoUrlNormalizado && this.logoTexto) return this.logoTexto;
    return this.nombreEmpresa || 'Barberia';
  }

  private blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  private csvLine(cells: Array<string | number>): string {
    return cells
      .map((cell) => {
        const raw = String(cell ?? '');
        const escaped = raw.replace(/"/g, '""');
        return `"${escaped}"`;
      })
      .join(',');
  }

  private formatearFechaHora(fecha: Date): string {
    return new Intl.DateTimeFormat('es-MX', {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(fecha);
  }

  private getTituloTablaPrincipal(): string {
    if (this.tipo === 'ventas-dia' || this.tipo === 'ventas-semana' || this.tipo === 'ventas-mes') {
      return 'Detalle de servicios (cortes) vendidos';
    }
    if (this.tipo === 'servicios-populares') return 'Detalle de servicios más populares';
    if (this.tipo === 'citas') return 'Detalle por estado de cita';
    if (this.tipo === 'horarios') return 'Detalle de ocupación por horario';
    if (this.tipo === 'productos-vendidos') return 'Detalle de productos vendidos';
    if (this.tipo === 'inventario') return 'Resumen de movimientos de inventario';
    return 'Detalle del reporte';
  }

  private agregarTotalFinalPDF(doc: any, etiqueta: string, total: number): void {
    const pageHeight = typeof doc.internal?.pageSize?.getHeight === 'function'
      ? doc.internal.pageSize.getHeight()
      : doc.internal?.pageSize?.height || 842;
    const margen = 40;
    const right = 555;
    let y = ((doc as any).lastAutoTable?.finalY || 120) + 28;

    if (y > pageHeight - 40) {
      doc.addPage();
      y = margen + 10;
    }

    const boxTop = y - 16;
    const boxHeight = 28;
    const boxWidth = right - margen;

    // Caja resaltada para que el total final sea claramente visible.
    doc.setFillColor(245, 245, 245);
    doc.setDrawColor(210, 210, 210);
    doc.rect(margen, boxTop, boxWidth, boxHeight, 'FD');

    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30);
    doc.text(etiqueta, margen + 10, y + 2);

    doc.setFontSize(13);
    doc.text(this.formatMonto(total), right - 10, y + 2, { align: 'right' });

    // Restaurar fuente por compatibilidad con llamadas posteriores.
    doc.setFont('helvetica', 'normal');
  }
}
