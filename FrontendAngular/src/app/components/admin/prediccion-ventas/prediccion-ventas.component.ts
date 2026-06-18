import { Component, HostListener, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { AdminService, PrediccionSerie, PrediccionVentasResponse } from '../../../services/admin.service';

type PeriodoVista = 'dia' | 'semana' | 'mes';
type TipoVista = 'tabla' | 'grafica';
type ModoGrafica = 'linea' | 'barras';
type FiltroBarras = 'ambos' | 'historico' | 'prediccion';
type ModoAnalisis = 'producto' | 'subcategoria';
type PredScope = 'dia' | 'mes';
type HorizonteVenta = 30 | 60 | 90 | 180 | 365;
type UnidadTiempo = 'día' | 'semana' | 'mes';

@Component({
  selector: 'app-prediccion-ventas',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './prediccion-ventas.component.html',
  styleUrl: './prediccion-ventas.component.css'
})
export class PrediccionVentasComponent implements OnInit, OnDestroy {
  private readonly adminService = inject(AdminService);
  private readonly route = inject(ActivatedRoute);

  loading = true;
  refreshing = false;
  error = '';
  modoPrueba = false;

  periodo: PeriodoVista = 'dia';
  vista: TipoVista = 'grafica';
  modoGrafica: ModoGrafica = 'linea';
  filtroBarras: FiltroBarras = 'ambos';
  modoAnalisis: ModoAnalisis = 'producto';
  barsAnimToken = 0;
  private filtrosDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  categoria = '';
  subcategoriaId: number | null = null;
  productoId: number | null = null;
  desde: string = '';
  hasta: string = '';
  predScope: PredScope = 'dia';
  horizonte: HorizonteVenta = 30;

  opcionesHorizonte: Array<{ label: string; value: HorizonteVenta }> = [
    { label: '1 Mes', value: 30 },
    { label: '2 Meses', value: 60 },
    { label: '3 Meses', value: 90 },
    { label: '6 Meses', value: 180 },
    { label: '1 Año', value: 365 },
  ];

  // ─────────────────────────────────────────────
  // Modelo matemático (dx/dt = kx) para UI tipo mock
  // ─────────────────────────────────────────────
  modeloX0: number | null = null;
  modeloFechaX0: string = '';        // fecha en que se registró x₀ (t=0)
  modeloXn: number | null = null;
  modeloFechaXn: string = '';        // fecha en que se registró xₙ
  modeloTn: number | null = null;
  modeloTp: number | null = null;
  modeloUnidad: UnidadTiempo = 'día';
  modeloCalculado = false;

  modeloK: number | null = null;
  modeloXt: number | null = null;
  modeloTpReal: number = 0;
  modeloTendencia: 'positiva' | 'negativa' | 'estable' = 'estable';

  /** Opciones 1–30 para el select de cantidad */
  readonly modeloTpOpciones: number[] = Array.from({ length: 30 }, (_, i) => i + 1);

  /**
   * Fecha proyectada: fecha de x₀ + modeloTpReal días.
   * Se calcula automáticamente al calcular la predicción.
   */
  get modeloFechaProyectada(): string {
    if (!this.modeloCalculado || !this.modeloFechaX0 || !(this.modeloTpReal > 0)) return '';
    const base = new Date(this.modeloFechaX0 + 'T00:00:00');
    if (isNaN(base.getTime())) return '';
    base.setDate(base.getDate() + Math.round(this.modeloTpReal));
    const dd = String(base.getDate()).padStart(2, '0');
    const mm = String(base.getMonth() + 1).padStart(2, '0');
    const yy = base.getFullYear();
    return `${dd}/${mm}/${yy}`;
  }

  /** Cuando el usuario cambia la fecha de x₀, auto-calcular tₙ si ya tiene fecha xₙ */
  onFechaX0Change(): void {
    this._recalcTnDesdeFechas();
  }

  /** Cuando el usuario cambia la fecha de xₙ, auto-calcular tₙ */
  onFechaXnChange(): void {
    this._recalcTnDesdeFechas();
  }

  private _recalcTnDesdeFechas(): void {
    if (!this.modeloFechaX0 || !this.modeloFechaXn) return;
    const d0 = new Date(this.modeloFechaX0 + 'T00:00:00');
    const dn = new Date(this.modeloFechaXn + 'T00:00:00');
    if (isNaN(d0.getTime()) || isNaN(dn.getTime())) return;
    const diff = Math.round((dn.getTime() - d0.getTime()) / 86_400_000);
    if (diff > 0) this.modeloTn = diff;
  }

  get serieBaseParaModelo(): number[] {
    const serie = this.tieneRangoFechasActivo
      ? (this.seriesRangoFechas.length ? this.seriesRangoFechas : this.seriesActual)
      : this.seriesActual;
    return (serie || []).map((x) => Number(x.valor) || 0);
  }

  usarDatosDeBDEnModelo(): void {
    const datos = this.serieBaseParaModelo;
    if (!datos.length) return;

    const nonZero = datos
      .map((v, i) => ({ v, i }))
      .filter(x => x.v > 0);

    if (nonZero.length < 2) return;

    const first = nonZero[0];
    const last  = nonZero[nonZero.length - 1];

    // t0 siempre = 0 en el modelo; tn = días transcurridos
    this.modeloX0 = Number(first.v);
    this.modeloXn = Number(last.v);
    this.modeloTn = Number(last.i - first.i);
    this.modeloTp = 1;
    this.modeloUnidad = 'mes';
    this.modeloCalculado = false;

    // Intentar llenar fechas desde las series visibles
    const serie = this.tieneRangoFechasActivo
      ? (this.seriesRangoFechas.length ? this.seriesRangoFechas : this.seriesActual)
      : this.seriesActual;
    if (serie?.length) {
      const nonZeroSeries = serie.filter(s => Number(s.valor) > 0);
      if (nonZeroSeries.length >= 2) {
        // label viene en formato YYYY-MM-DD o YYYY-MM
        const toIso = (lbl: string) => lbl.length === 7 ? lbl + '-01' : lbl.slice(0, 10);
        this.modeloFechaX0 = toIso(nonZeroSeries[0].label);
        this.modeloFechaXn = toIso(nonZeroSeries[nonZeroSeries.length - 1].label);
      }
    }
  }

  calcularPrediccionModelo(): void {
    const x0  = Number(this.modeloX0);
    const xn  = Number(this.modeloXn);
    const tn  = Number(this.modeloTn);   // días entre x0 y xn
    const num = Number(this.modeloTp);   // cantidad que ingresó el usuario
    const un  = this.modeloUnidad;

    // validaciones
    if (![x0, xn, num].every(v => Number.isFinite(v) && v > 0)) return;
    if (!Number.isFinite(tn) || tn <= 0) return;

    // tp: N días contados desde t=0 (fecha de x₀)
    const tp = this._calcTpDesdeCantidad(tn, num, un);

    // Ley de Crecimiento y Decrecimiento — única fórmula
    const k  = Math.log(xn / x0) / tn;
    const xt = x0 * Math.exp(k * tp);

    this.modeloK         = Number(k.toFixed(6));
    this.modeloXt        = Number(Math.max(0, xt).toFixed(2));
    this.modeloTpReal    = tp;
    this.modeloTendencia = k > 0.05 ? 'positiva' : (k < -0.05 ? 'negativa' : 'estable');
    this.modeloCalculado = true;
  }

  /** Convierte (num, unidad) a días desde t=0 → tp
   *  "Predecir para los próximos N días" significa N días contados
   *  desde el punto t=0 (fecha de x₀), NO desde xₙ.
   *  Por tanto tp = diasConvertidos  (sin sumar tn).
   */
  private _calcTpDesdeCantidad(_tn: number, num: number, un: UnidadTiempo): number {
    if (un === 'día')         return num;
    else if (un === 'semana') return num * 7;
    else                      return num * 30;   // mes
  }

  get pasosModelo(): Array<{ n: string; txt: string }> {
    if (!this.modeloCalculado || this.modeloK == null || this.modeloXt == null) return [];

    const x0  = Number(this.modeloX0  || 0);
    const xn  = Number(this.modeloXn  || 0);
    const tn  = Number(this.modeloTn  || 0);
    const num = Number(this.modeloTp  || 0);
    const un  = this.modeloUnidad;
    const k   = Number(this.modeloK);
    const tp  = this.modeloTpReal;

    // etiqueta de conversión
    let convLabel: string;
    if (un === 'día') {
      convLabel = `${num} día(s) desde t = 0  →  tp = ${tp} días`;
    } else if (un === 'semana') {
      convLabel = `${num} sem × 7 = ${num * 7} días desde t = 0  →  tp = ${tp} días`;
    } else {
      convLabel = `${num} mes(es) × 30 = ${num * 30} días desde t = 0  →  tp = ${tp} días`;
    }

    return [
      { n: '1', txt: 'Planteamiento:  dx/dt = kx' },
      { n: '2', txt: 'Separación de variables:  dx / x = k dt' },
      { n: '3', txt: 'Integración:  ∫dx/x = k∫dt  →  ln(x) = kt + C' },
      { n: '4', txt: 'Despeje de x:  x = e^(kt+C)  =  C · e^(kt)' },
      { n: '5', txt: `Condición inicial  (t = 0, x = x₀ = ${x0}):  C = ${x0}` },
      { n: '6', txt: `Cálculo de k:  k = ln(${xn} / ${x0}) / ${tn}  =  ${k.toFixed(6)}` },
      { n: '7', txt: `Ecuación particular:  x(t) = ${x0} · e^(${k.toFixed(4)} · t)` },
      { n: '8', txt: `Conversión: ${convLabel!}` },
      { n: '9', txt: `Predicción:  x(${tp}) = ${x0} · e^(${k.toFixed(4)} × ${tp})  ≈  ${this.modeloXt!.toFixed(2)} U` },
    ];
  }

  get curvePointsModelo(): Array<{ x: number; y: number }> {
    if (!this.modeloCalculado || this.modeloK == null) return [];

    const x0 = Number(this.modeloX0 || 0);
    const k  = Number(this.modeloK);
    const tp = this.modeloTpReal;

    if (!(x0 > 0) || !Number.isFinite(tp) || tp <= 0) return [];

    const tMax  = tp * 1.25;
    const steps = 60;
    const out: Array<{ x: number; y: number }> = [];

    for (let i = 0; i <= steps; i++) {
      const t = (tMax * i) / steps;
      const y = Math.max(0, x0 * Math.exp(k * t));
      out.push({ x: Number(t.toFixed(2)), y: Number(y.toFixed(2)) });
    }
    return out;
  }

  get curveSvgPoints(): string {
    const pts = this.curvePointsModelo;
    if (!pts.length) return '';
    const maxX = Math.max(...pts.map((p) => p.x), 1);
    const maxY = Math.max(...pts.map((p) => p.y), 1);
    return pts
      .map((p) => {
        const x = (p.x / maxX) * 100;
        const y = 100 - ((p.y / maxY) * 100);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }

  get mostrarCurvaModelo(): boolean {
    return !!(this.modeloCalculado && this.modeloTpReal > 0 && this.curveSvgPoints);
  }

  get curveY0Pct(): number {
    const pts = this.curvePointsModelo;
    if (!pts.length) return 100;
    const maxY = Math.max(...pts.map(p => p.y), 1);
    return Number((100 - ((Number(this.modeloX0 || 0) / maxY) * 100)).toFixed(2));
  }

  get curveTpPct(): number {
    const pts = this.curvePointsModelo;
    if (!pts.length) return 100;
    const maxX = Math.max(...pts.map(p => p.x), 1);
    return Number(((this.modeloTpReal / maxX) * 100).toFixed(2));
  }

  get curveYtPct(): number {
    const pts = this.curvePointsModelo;
    if (!pts.length) return 100;
    const maxY = Math.max(...pts.map(p => p.y), 1);
    return Number((100 - ((Number(this.modeloXt || 0) / maxY) * 100)).toFixed(2));
  }

  get detalleVentasFiltrado(): Array<{ fecha: string; producto: string; valor: number }> {
    if (!this.data) return [];

    // Para rango de fechas, usar serie diaria del backend (incluye ceros).
    // Si no hay rango activo, usar últimos 30 días (ventas.dia).
    const serieDia = (this.tieneRangoFechasActivo && this.data.ventas_rango?.dia?.length)
      ? (this.data.ventas_rango?.dia || [])
      : (this.data.ventas?.dia || []);
    const prodNombre = this.data.seleccion?.producto_nombre ||
      this.data.seleccion?.categoria || 'Producto';

    return serieDia
      .filter(s => {
        const v = Number(s.valor) || 0;
        // En detalle semanal queremos mostrar también 0 (para mencionar días sin ventas),
        // pero este getter se usa como base; filtraremos en la UI si se requiere.
        // filtrar por rango de fechas si está activo
        if (this.desde && s.label < this.desde) return false;
        if (this.hasta && s.label > this.hasta) return false;
        return true;
      })
      .map(s => ({
        fecha: s.label.split('-').reverse().join('/'),   // ISO → DD/MM/YYYY
        producto: prodNombre,
        valor: Number(s.valor)
      }));
  }

  // ─────────────────────────────────────────────
  // Detalle por semanas (Lun–Dom) + paginación
  // ─────────────────────────────────────────────
  detalleSemanaPage = 0;
  readonly detalleSemanasPorPagina = 4;

  private _parseISO(iso: string): Date | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }

  private _iso(dateObj: Date): string {
    const y = dateObj.getFullYear();
    const m = String(dateObj.getMonth() + 1).padStart(2, '0');
    const d = String(dateObj.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  private _mondayStart(d: Date): Date {
    const out = new Date(d);
    const day = out.getDay(); // 0 dom .. 6 sáb
    const diff = (day === 0 ? -6 : 1) - day; // mover a lunes
    out.setDate(out.getDate() + diff);
    out.setHours(0, 0, 0, 0);
    return out;
  }

  private _formatDDMMYYYY(iso: string): string {
    const p = String(iso || '').split('-');
    if (p.length !== 3) return iso;
    return `${p[2]}/${p[1]}/${p[0]}`;
  }

  get detalleVentasSemanas(): Array<{
    semanaKey: string;
    inicioISO: string;
    finISO: string;
    inicioLabel: string;
    finLabel: string;
    filas: Array<{ fechaISO: string; fecha: string; producto: string; valor: number }>;
    totalSemana: number;
    diasSinVentas: number;
  }> {
    if (!this.data) return [];
    const prodNombre = this.data.seleccion?.producto_nombre ||
      this.data.seleccion?.categoria || 'Producto';

    const base = (this.tieneRangoFechasActivo && this.data.ventas_rango?.dia?.length)
      ? (this.data.ventas_rango?.dia || [])
      : (this.data.ventas?.dia || []);

    const rows = base
      .filter((s) => {
        if (this.desde && s.label < this.desde) return false;
        if (this.hasta && s.label > this.hasta) return false;
        return true;
      })
      .map((s) => ({
        fechaISO: s.label,
        fecha: this._formatDDMMYYYY(s.label),
        producto: prodNombre,
        valor: Number(s.valor) || 0,
      }));

    // agrupar por lunes
    const map = new Map<string, Array<{ fechaISO: string; fecha: string; producto: string; valor: number }>>();
    rows.forEach((r) => {
      const d = this._parseISO(r.fechaISO);
      if (!d) return;
      const monday = this._mondayStart(d);
      const key = this._iso(monday);
      const arr = map.get(key) || [];
      arr.push(r);
      map.set(key, arr);
    });

    const weeks = Array.from(map.entries())
      .map(([inicioISO, filas]) => {
        const inicioD = this._parseISO(inicioISO)!;
        const finD = new Date(inicioD);
        finD.setDate(finD.getDate() + 6);
        const finISO = this._iso(finD);
        // ordenar filas por fecha
        filas.sort((a, b) => (a.fechaISO < b.fechaISO ? -1 : a.fechaISO > b.fechaISO ? 1 : 0));
        const totalSemana = Number(filas.reduce((acc, f) => acc + (Number(f.valor) || 0), 0).toFixed(2));
        const diasSinVentas = filas.filter((f) => (Number(f.valor) || 0) <= 0).length;
        return {
          semanaKey: inicioISO,
          inicioISO,
          finISO,
          inicioLabel: this._formatDDMMYYYY(inicioISO),
          finLabel: this._formatDDMMYYYY(finISO),
          filas,
          totalSemana,
          diasSinVentas,
        };
      })
      .sort((a, b) => (a.inicioISO < b.inicioISO ? -1 : 1));

    return weeks;
  }

  get detalleSemanasTotalPaginas(): number {
    const total = this.detalleVentasSemanas.length;
    return Math.max(1, Math.ceil(total / this.detalleSemanasPorPagina));
  }

  get detalleSemanasPaginaActual(): number {
    const max = this.detalleSemanasTotalPaginas;
    return Math.min(Math.max(0, this.detalleSemanaPage), max - 1);
  }

  get detalleSemanasVisibles(): Array<{
    semanaKey: string;
    inicioLabel: string;
    finLabel: string;
    filas: Array<{ fechaISO: string; fecha: string; producto: string; valor: number }>;
    totalSemana: number;
    diasSinVentas: number;
  }> {
    const page = this.detalleSemanasPaginaActual;
    const start = page * this.detalleSemanasPorPagina;
    return this.detalleVentasSemanas.slice(start, start + this.detalleSemanasPorPagina);
  }

  detalleSemanasPrev(): void {
    this.detalleSemanaPage = Math.max(0, this.detalleSemanasPaginaActual - 1);
  }

  detalleSemanasNext(): void {
    this.detalleSemanaPage = Math.min(this.detalleSemanasTotalPaginas - 1, this.detalleSemanasPaginaActual + 1);
  }

  /** Filtra las filas de una semana dejando solo las que tienen ventas > 0. */
  filasConVentas(filas: Array<{ fechaISO: string; fecha: string; producto: string; valor: number }>): Array<{ fechaISO: string; fecha: string; producto: string; valor: number }> {
    return (filas || []).filter(f => (Number(f.valor) || 0) > 0);
  }

  /** Número de la última semana visible en el paginador (para el label "X–Y de N"). */
  get detallePagerHasta(): number {
    return Math.min(
      (this.detalleSemanasPaginaActual + 1) * this.detalleSemanasPorPagina,
      this.detalleVentasSemanas.length
    );
  }

  get detalleMencionDiasSinVentas(): string {
    const semanas = this.detalleVentasSemanas;
    if (!semanas.length) return '';
    const diasSin = semanas.reduce((acc, w) => acc + (Number(w.diasSinVentas) || 0), 0);
    return diasSin > 0 ? `Nota: ${diasSin} día(s) del rango no tuvieron ventas (0 U).` : 'Nota: todos los días del rango tuvieron ventas.';
  }

  data: PrediccionVentasResponse | null = null;
  etiquetasCompactas = false;

  ngOnInit(): void {
    this.modoPrueba = this.route.snapshot.data['modo'] === 'prueba';
    this.actualizarModoEtiquetas();
    this.cargar();
  }

  ngOnDestroy(): void {
    if (this.filtrosDebounceTimer) {
      clearTimeout(this.filtrosDebounceTimer);
      this.filtrosDebounceTimer = null;
    }
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.actualizarModoEtiquetas();
  }

  cargar(): void {
    const firstLoad = !this.data;
    this.loading = firstLoad;
    this.refreshing = !firstLoad;
    this.error = '';
    this.adminService.getPrediccionVentas({
      categoria: this.categoria || undefined,
      subcategoria_id: this.subcategoriaId,
      producto_id: this.productoId,
      desde: this.desde || undefined,
      hasta: this.hasta || undefined,
      pred_scope: this.predScope,
      modo: this.modoPrueba ? 'prueba' : undefined
    }).subscribe({
      next: (res) => {
        this.loading = false;
        this.refreshing = false;
        if (!res?.ok) {
          this.error = 'No se pudo cargar la predicción.';
          return;
        }
        this.data = res;
        // Mantener selección del usuario y solo ajustar cuando ya no existe en los nuevos filtros.
        if (!this.categoria) {
          this.categoria = res.seleccion?.categoria || this.categoria;
        }

        const subcategorias = res.filtros?.subcategorias || [];
        const productos = res.filtros?.productos || [];
        const subActualExiste = this.subcategoriaId != null && subcategorias.some((s) => s.id === this.subcategoriaId);
        const prodActualExiste = this.productoId != null && productos.some((p) => p.id === this.productoId);

        if (!subActualExiste) {
          this.subcategoriaId = res.seleccion?.subcategoria_id ?? null;
        }
        if (!prodActualExiste) {
          this.productoId = res.seleccion?.producto_id ?? null;
        }
      },
      error: () => {
        this.loading = false;
        this.refreshing = false;
        this.error = this.data ? 'No se pudieron actualizar los filtros en este momento.' : 'Error al obtener datos de predicción.';
      }
    });
  }

  onCategoriaChange(): void {
    this.subcategoriaId = null;
    this.productoId = null;
    this.programarCargaFiltros();
  }

  onCategoriaInput(event: Event): void {
    const value = (event.target as HTMLSelectElement)?.value || '';
    this.categoria = value;
    this.onCategoriaChange();
  }

  onSubcategoriaChange(): void {
    this.productoId = null;
    this.programarCargaFiltros();
  }

  onSubcategoriaInput(event: Event): void {
    const raw = (event.target as HTMLSelectElement)?.value || '';
    const parsed = Number.parseInt(raw, 10);
    this.subcategoriaId = Number.isNaN(parsed) ? null : parsed;
    this.onSubcategoriaChange();
  }

  onProductoChange(): void {
    this.programarCargaFiltros();
  }

  onProductoInput(event: Event): void {
    const raw = (event.target as HTMLSelectElement)?.value || '';
    const parsed = Number.parseInt(raw, 10);
    this.productoId = Number.isNaN(parsed) ? null : parsed;
    this.onProductoChange();
  }

  onDesdeInput(event: Event): void {
    const value = (event.target as HTMLInputElement)?.value || '';
    this.desde = value;
    this.programarCargaFiltros();
  }

  onHastaInput(event: Event): void {
    const value = (event.target as HTMLInputElement)?.value || '';
    this.hasta = value;
    this.programarCargaFiltros();
  }

  limpiarRangoFechas(): void {
    this.desde = '';
    this.hasta = '';
    this.programarCargaFiltros();
  }

  cambiarPredScope(scope: PredScope): void {
    if (this.predScope !== scope) {
      this.predScope = scope;
      this.programarCargaFiltros();
    }
  }

  cambiarHorizonte(value: string): void {
    const parsed = Number.parseInt(value, 10) as HorizonteVenta;
    const allowed: HorizonteVenta[] = [30, 60, 90, 180, 365];
    this.horizonte = (allowed.includes(parsed) ? parsed : 30);
  }

  onHorizonteInput(event: Event): void {
    const value = ((event.target as HTMLSelectElement | null)?.value ?? '').toString();
    this.cambiarHorizonte(value);
  }


  get titulo(): string {
    return this.modoPrueba ? 'Predicción de Ventas (Prueba)' : 'Predicción de Ventas';
  }

  get subtitulo(): string {
    return this.modoPrueba
      ? 'Escenario con datos ficticios para validación académica.'
      : 'Análisis por categoría, subcategoría (marca) y producto.';
  }

  get periodoTitulo(): string {
    if (this.periodo === 'mes') return 'Ventas por Mes';
    if (this.periodo === 'semana') return 'Ventas por Semana';
    return `Ventas por Día`;
  }

  get analisisTitulo(): string {
    return this.modoAnalisis === 'subcategoria' ? 'Análisis de Subcategoría (Marca)' : 'Análisis de Producto';
  }

  get seriesActual(): PrediccionSerie[] {
    if (!this.data) return [];
    const source = this.modoAnalisis === 'subcategoria'
      ? (this.data.subcategoria_ventas || { dia: [], semana: [], mes: [] })
      : this.data.ventas;
    // Cuando hay rango de fechas activo (solo producto), usar la serie diaria exacta para que
    // la gráfica responda a los filtros de fecha.
    if (
      this.periodo === 'dia' &&
      this.modoAnalisis === 'producto' &&
      this.tieneRangoFechasActivo &&
      (this.data.ventas_rango?.dia?.length || 0) > 0
    ) {
      return this.data.ventas_rango?.dia || [];
    }
    if (this.periodo === 'semana') return source?.semana || [];
    if (this.periodo === 'mes') return source?.mes || [];
    return source?.dia || [];
  }

  get seriesRangoFechas(): PrediccionSerie[] {
    const r = this.data?.ventas_rango;
    if (!r?.dia?.length) return [];
    return r.dia;
  }

  get tieneRangoFechasActivo(): boolean {
    return !!(this.desde && this.hasta);
  }

  get rangoFechasTitulo(): string {
    if (!this.tieneRangoFechasActivo) return '';
    const d = this.desde || '';
    const h = this.hasta || '';
    return `${d} a ${h}`;
  }

  get prediccionCrecimientoK(): number | null {
    const k = this.data?.prediccion_crecimiento?.k;
    return typeof k === 'number' ? Number(k) : null;
  }

  get prediccionCrecimientoValoresBase(): number[] {
    const vals = this.data?.prediccion_crecimiento?.base?.valores;
    return Array.isArray(vals) ? vals.map((v) => Number(v) || 0) : [];
  }

  get prediccionCrecimientoPredicciones(): number[] {
    const vals = this.data?.prediccion_crecimiento?.predicciones;
    return Array.isArray(vals) ? vals.map((v) => Number(v) || 0) : [];
  }

  get prediccionCrecimientoValorPrincipal(): number {
    const p = this.data?.prediccion_crecimiento;
    if (!p) return 0;
    if (this.predScope === 'mes') return Number(p.venta_proyectada_mes_siguiente || 0);
    return Number(p.venta_proyectada_siguientes_6_dias || 0);
  }

  get kpiUnidadesVendidas30(): number {
    return Number(this.data?.kpis_ventas?.unidades_vendidas || 0);
  }

  get kpiTickets30(): number {
    return Number(this.data?.kpis_ventas?.tickets_entregados || 0);
  }

  get kpiPromedioDiario30(): number {
    return Number(this.data?.kpis_ventas?.promedio_diario || 0);
  }

  get ventasScopeLabel(): string {
    if (!this.data) return '';
    const prod = this.data.seleccion?.producto_nombre || '';
    const cat = this.data.seleccion?.categoria || '';
    return prod ? `${prod} — ${cat}` : cat;
  }

  get simulacionVentasDiarias(): Array<{ dia: number; fecha: Date; ventas: number }> {
    const k = this.prediccionCrecimientoK;
    const base = this.prediccionCrecimientoValoresBase;
    if (k == null || !base.length) return [];

    // N0 = último valor observado en base
    const n0 = Number(base[base.length - 1] || 0);
    const out: Array<{ dia: number; fecha: Date; ventas: number }> = [];
    const hoy = new Date();
    for (let t = 0; t <= this.horizonte; t++) {
      const fecha = new Date(hoy);
      fecha.setDate(hoy.getDate() + t);
      const ventas = Math.max(0, Number((n0 * Math.exp(Number(k) * t)).toFixed(2)));
      out.push({ dia: t, fecha, ventas });
    }
    return out;
  }

  get ventasProyectadasTotalHorizonte(): number {
    const rows = this.simulacionVentasDiarias;
    if (!rows.length) return 0;
    return Number(rows.reduce((acc, r) => acc + (Number(r.ventas) || 0), 0).toFixed(2));
  }

  get seriesVisible(): PrediccionSerie[] {
    const serie = this.seriesActual;
    if (this.periodo === 'dia') {
      // Con rango activo mostramos todo el rango (incluye ceros); si es muy largo, la UI de barras
      // ya permite scroll horizontal.
      if (this.tieneRangoFechasActivo) return serie;
      return serie.slice(-7);
    }
    if (this.periodo === 'semana') return serie.slice(-6);
    // Solo 4 meses en el gráfico (histórico azul); el backend sigue trayendo la serie completa.
    return serie.slice(-4);
  }

  get limiteSerieTexto(): string {
    if (this.periodo === 'dia') {
      if (this.tieneRangoFechasActivo) return `Rango seleccionado: ${this.desde} a ${this.hasta}`;
      return 'Mostrando últimos 7 días';
    }
    if (this.periodo === 'semana') return 'Mostrando últimas 6 semanas';
    return 'Últimos 4 meses (total por mes calendario); la proyección usa esos mismos totales';
  }

  get maxSerie(): number {
    const values = this.seriesVisible.map(s => Number(s.valor) || 0);
    return Math.max(1, ...values);
  }

  get serieProyectada(): PrediccionSerie[] {
    const base = this.seriesVisible.map(s => Number(s.valor) || 0);
    if (!base.length) return [];

    // En vista mensual usamos la predicción oficial del backend para evitar desalineaciones
    // entre tarjetas, API y gráfico.
    if (this.periodo === 'mes' && this.data) {
      const backendLineal = this.modoAnalisis === 'subcategoria'
        ? (this.data.subcategoria_prediccion?.lineal || [])
        : (this.data.prediccion?.lineal || []);
      if (backendLineal.length) {
        const labels = this.generarEtiquetasFuturas(this.seriesVisible, backendLineal.length);
        return backendLineal.map((v, i) => ({ label: labels[i], valor: Number((Number(v) || 0).toFixed(2)) }));
      }
    }

    // En día/semana mantenemos cálculo local sobre la ventana visible.
    const preds = this.predecirLineal(base, 3);
    const labels = this.generarEtiquetasFuturas(this.seriesVisible, preds.length);
    return preds.map((v, i) => ({ label: labels[i], valor: Number(v.toFixed(2)) }));
  }

  /** Primer punto de la predicción (amarillo): mismo valor en tarjetas y bloque inferior. */
  get kpiVentaProyectadaSiguiente(): number {
    const s = this.serieProyectada;
    if (!s.length) return 0;
    return Number((Number(s[0].valor) || 0).toFixed(2));
  }

  /** Reorden coherente con la proyección mostrada (como en backend: max(stock_mín, ceil(venta_sig × 0.5))). */
  get puntoReordenConsistente(): number {
    if (!this.data?.prediccion) return 0;
    if (this.modoAnalisis === 'producto') {
      return Number(this.data.prediccion.punto_reorden_sugerido ?? 0);
    }
    const stockMin = Number(this.data.prediccion.stock_minimo ?? 0);
    const next = this.kpiVentaProyectadaSiguiente;
    return Math.max(stockMin, Math.ceil(next * 0.5));
  }

  get kpiProyeccionStatLabel(): string {
    if (this.periodo === 'dia') return 'Siguiente día proyectado (unidades)';
    if (this.periodo === 'semana') return 'Siguiente semana proyectada (unidades)';
    return 'Siguiente mes proyectado (unidades)';
  }

  get tendenciaVistaPalabra(): string {
    const p = this.tendenciaPorcentaje;
    if (p > 0.5) return 'positiva';
    if (p < -0.5) return 'negativa';
    return 'estable';
  }

  get serieCombinadaGrafica(): Array<{ label: string; valor: number; prediccion: boolean }> {
    const hist = this.seriesVisible.map(s => ({ label: s.label, valor: Number(s.valor) || 0, prediccion: false }));
    // En la gráfica principal (Sección 01) ya no se muestra proyección amarilla.
    // Solo histórico azul, respetando filtros activos (incluyendo rango de fechas).
    return hist;
  }

  get serieBarrasVisible(): Array<{ label: string; valor: number; prediccion: boolean }> {
    const serie = this.serieCombinadaGrafica;
    if (this.filtroBarras === 'historico') return serie.filter(s => !s.prediccion);
    if (this.filtroBarras === 'prediccion') return serie.filter(s => s.prediccion);
    return serie;
  }

  get serieLineaVisible(): Array<{ label: string; valor: number; prediccion: boolean }> {
    return this.serieBarrasVisible;
  }

  get indiceInicioPrediccion(): number {
    return this.seriesVisible.length;
  }

  get productosListado(): Array<{ producto_id: number; producto_nombre: string; stock_disponible: number; ventas_totales: number }> {
    return this.data?.productos_listado || [];
  }

  get maxSerieCombinada(): number {
    const values = this.serieLineaVisible.map(s => Number(s.valor) || 0);
    return Math.max(1, ...values);
  }

  get maxSerieBarras(): number {
    const values = this.serieBarrasVisible.map(s => Number(s.valor) || 0);
    return Math.max(1, ...values);
  }

  get maxSerieEjeBase(): number {
    return this.modoGrafica === 'barras' ? this.maxSerieBarras : this.maxSerieCombinada;
  }

  get maxEjeYActual(): number {
    return this.normalizarMaxEje(this.maxSerieEjeBase);
  }

  get yStepActual(): number {
    return this.calcularStepEje(this.maxSerieEjeBase);
  }

  get yTicks(): number[] {
    const max = this.maxEjeYActual;
    const step = this.yStepActual;
    const ticks: number[] = [];
    for (let v = max; v >= -0.000001; v -= step) ticks.push(Number(v.toFixed(2)));
    if (ticks[ticks.length - 1] !== 0) ticks.push(0);
    return ticks;
  }

  get yGridPcts(): number[] {
    return this.yTicks
      .map((t) => this.yTickTopPct(t))
      .filter((pct) => pct > 0 && pct < 100);
  }

  get barGridStepPct(): number {
    const segments = Math.max(1, this.yTicks.length - 1);
    return Number((100 / segments).toFixed(2));
  }

  yTickTopPct(value: number): number {
    return this.yPct(value, this.maxEjeYActual);
  }

  formatYTick(value: number): string {
    const rounded = Number(value.toFixed(2));
    const asInt = Math.round(rounded);
    const txt = Math.abs(rounded - asInt) < 0.000001
      ? `${asInt}`
      : `${rounded.toFixed(1).replace(/\.0$/, '')}`;
    return `${txt} U`;
  }

  formatCantidad(value: number | null | undefined): string {
    const n = Number(value || 0);
    if (Number.isInteger(n)) return String(n);
    return n.toFixed(2).replace(/\.?0+$/, '');
  }

  formatEnteroMiles(value: number | null | undefined): string {
    const n = Number(value || 0);
    return Math.round(n).toLocaleString('en-US');
  }

  seleccionarProductoListado(productoId: number): void {
    this.productoId = productoId;
    this.vista = 'tabla';
    this.cargar();
  }

  predecirProductoListado(productoId: number): void {
    this.productoId = productoId;
    this.vista = 'grafica';
    this.cargar();
  }

  cambiarPeriodo(p: PeriodoVista): void {
    if (this.periodo !== p) {
      this.periodo = p;
      this.filtroBarras = 'ambos';
      this.barsAnimToken += 1;
    }
  }

  esInicioPrediccion(index: number): boolean {
    return index === this.indiceInicioPrediccion;
  }

  esInicioPrediccionBarra(index: number): boolean {
    const actual = this.serieBarrasVisible[index];
    if (!actual?.prediccion) return false;
    if (index === 0) return true;
    const anterior = this.serieBarrasVisible[index - 1];
    return !anterior?.prediccion;
  }

  cambiarFiltroBarras(filtro: FiltroBarras): void {
    if (this.filtroBarras !== filtro) {
      this.filtroBarras = filtro;
      this.barsAnimToken += 1;
    }
  }

  /** Alias del KPI inferior: mismo número que el 1.er periodo proyectado en el gráfico. */
  get ventaProyectada30Dias(): number {
    return this.kpiVentaProyectadaSiguiente;
  }

  get proyeccionKpiTitulo(): string {
    return this.kpiProyeccionStatLabel;
  }

  get proyeccionKpiDescripcion(): string {
    return 'Unidades del producto o marca seleccionada; coincide con el primer punto amarillo (regresión lineal sobre la ventana del gráfico).';
  }

  /**
   * % de cambio entre el 1.er y el 3.er valor proyectado (línea amarilla).
   * Si no hay proyección, cae al histórico visible (con manejo de ceros al inicio).
   */
  get tendenciaPorcentaje(): number {
    const pred = this.serieProyectada.map((s) => Number(s.valor) || 0);
    if (pred.length >= 2) {
      const a = pred[0];
      const b = pred[pred.length - 1];
      const base = Math.max(Math.abs(a), 1e-6);
      return Number((((b - a) / base) * 100).toFixed(2));
    }
    const hist = this.seriesVisible;
    if (!hist.length) return 0;
    const first = Number(hist[0]?.valor || 0);
    const last = Number(hist[hist.length - 1]?.valor || 0);
    if (first > 0) {
      return Number((((last - first) / first) * 100).toFixed(2));
    }
    if (last > 0 && hist.length >= 2) {
      const prev = Number(hist[hist.length - 2]?.valor || 0);
      if (prev > 0) {
        return Number((((last - prev) / prev) * 100).toFixed(2));
      }
      return 100;
    }
    return 0;
  }

  get tendenciaEsPositiva(): boolean {
    return this.tendenciaPorcentaje > 0.5;
  }

  get tendenciaClaseCss(): string {
    if (this.tendenciaPorcentaje > 0.5) return 'text-success';
    if (this.tendenciaPorcentaje < -0.5) return 'text-error';
    return 'text-muted';
  }

  get tendenciaBadgeTexto(): string {
    if (this.tendenciaPorcentaje > 0.5) return `Arriba ${this.tendenciaPorcentaje}%`;
    if (this.tendenciaPorcentaje < -0.5) return `Abajo ${this.tendenciaPorcentaje}%`;
    return `${this.tendenciaPorcentaje}%`;
  }

  private get backtestingActual():
    | { muestras: number; mae: number | null; mape: number | null; precision_porcentaje: number | null }
    | null {
    if (!this.data) return null;
    if (this.modoAnalisis === 'subcategoria') {
      return this.data.subcategoria_prediccion?.backtesting || null;
    }
    return this.data.prediccion?.backtesting || null;
  }

  get precisionPronostico(): number | null {
    const p = this.backtestingActual?.precision_porcentaje;
    return typeof p === 'number' ? Number(p.toFixed(2)) : null;
  }

  get mapePronostico(): number | null {
    const p = this.backtestingActual?.mape;
    return typeof p === 'number' ? Number(p.toFixed(2)) : null;
  }

  get maePronostico(): number | null {
    const p = this.backtestingActual?.mae;
    return typeof p === 'number' ? Number(p.toFixed(2)) : null;
  }

  get muestrasBacktesting(): number {
    return Number(this.backtestingActual?.muestras || 0);
  }

  get precisionPronosticoTexto(): string {
    const val = this.precisionPronostico;
    if (val == null) return 'Sin datos';
    return `${val}%`;
  }

  get precisionPronosticoDetalle(): string {
    const muestras = this.muestrasBacktesting;
    const mae = this.maePronostico;
    const mape = this.mapePronostico;
    if (!muestras || mae == null || mape == null) {
      return 'Se requieren más periodos históricos para evaluar precisión.';
    }
    return `Backtesting lineal (${muestras} muestras): MAE ${mae} U · MAPE ${mape}%.`;
  }

  get participacionProductos(): Array<{ producto_id: number; nombre: string; unidades: number; porcentaje: number }> {
    return this.data?.subcategoria?.participacion_productos || [];
  }

  colorParticipacion(index: number): string {
    const hue = Math.round((index * 137.508) % 360);
    return `hsl(${hue} 84% 58%)`;
  }

  get tendenciaTexto(): string {
    const pct = this.tendenciaPorcentaje;
    if (this.serieProyectada.length >= 2) {
      if (pct > 0.5) return `${pct}% de cambio entre el 1.er y el último periodo proyectado (amarillo).`;
      if (pct < -0.5) return `${pct}% de cambio entre el 1.er y el último periodo proyectado (amarillo).`;
      return 'Proyección casi plana entre el 1.er y el 3.er periodo en el gráfico.';
    }
    if (pct > 0.5) return `${pct}% en el histórico visible (azul).`;
    if (pct < -0.5) return `${pct}% en el histórico visible (azul).`;
    return 'Sin variación clara en la ventana mostrada.';
  }

  private programarCargaFiltros(): void {
    if (this.filtrosDebounceTimer) {
      clearTimeout(this.filtrosDebounceTimer);
    }
    this.filtrosDebounceTimer = setTimeout(() => {
      this.filtrosDebounceTimer = null;
      this.cargar();
    }, 180);
  }

  get puntosLineaHistorica(): string {
    const total = this.serieLineaVisible.length;
    const hist = this.serieLineaVisible.filter((s) => !s.prediccion);
    if (!hist.length) return '';
    const start = this.filtroBarras === 'prediccion' ? 0 : 0;
    return hist
      .map((s, i) => `${this.xPct(start + i, total)},${this.yPct(Number(s.valor) || 0, this.maxEjeYActual)}`)
      .join(' ');
  }

  get puntosLineaPrediccion(): string {
    return '';
  }

  puntoLeftPct(index: number): number {
    return this.xPct(index, this.serieLineaVisible.length);
  }

  puntoTopPct(valor: number): number {
    return this.yPct(Number(valor) || 0, this.maxEjeYActual);
  }

  alturaBarraPct(valor: number): number {
    const n = Number(valor) || 0;
    if (n <= 0) return 0;
    return Number(((n / this.maxEjeYActual) * 100).toFixed(2));
  }

  tieneValorPositivo(valor: number): boolean {
    return (Number(valor) || 0) > 0;
  }

  formatearEtiqueta(label: string): string {
    if (this.periodo === 'dia') {
      const parsed = this.parseFecha(label);
      if (!parsed) return label;
      return this.formatFechaCompleta(parsed);
    }
    if (this.periodo === 'semana') {
      const rango = this.parseSemanaLabel(label);
      if (!rango) return label;
      return `Del ${this.formatFechaCompleta(rango.inicio)} al ${this.formatFechaCompleta(rango.fin)}`;
    }
    return this.formatMesAnio(label);
  }

  formatearEtiquetaCorta(label: string): string {
    if (this.periodo === 'dia') {
      const parsed = this.parseFecha(label);
      if (!parsed) return label;
      return this.etiquetasCompactas ? this.formatFechaDiaUltraCorta(parsed) : this.formatFechaCorta(parsed);
    }
    if (this.periodo === 'semana') {
      const rango = this.parseSemanaLabel(label);
      if (!rango) return label;
      if (this.etiquetasCompactas) {
        return this.formatRangoSemanalUltraCorto(rango.inicio, rango.fin);
      }
      return this.formatRangoSemanalCorto(rango.inicio, rango.fin);
    }
    return this.etiquetasCompactas ? this.formatMesCorto(label) : this.formatMesAnio(label);
  }

  formatearEtiquetaTooltip(label: string): string {
    return this.formatearEtiqueta(label);
  }

  private xPct(index: number, total: number): number {
    if (total <= 1) return 0;
    return Number(((index / (total - 1)) * 100).toFixed(2));
  }

  private yPct(valor: number, max: number): number {
    if (max <= 0) return 100;
    return Number((100 - ((valor / max) * 100)).toFixed(2));
  }

  private normalizarMaxEje(max: number): number {
    if (max <= 0) return 1;
    const step = this.calcularStepEje(max);
    return Number((Math.ceil(max / step) * step).toFixed(2));
  }

  private calcularStepEje(max: number): number {
    if (max <= 2) return 0.2;
    if (max <= 5) return 0.5;
    if (max <= 20) return 2;
    if (max <= 100) return 10;
    return 20;
  }

  private predecirLineal(values: number[], horizon: number): number[] {
    const n = values.length;
    if (n <= 1) {
      const base = values[0] || 0;
      return Array.from({ length: horizon }, () => Math.max(0, base));
    }
    const x = Array.from({ length: n }, (_, i) => i + 1);
    const sx = x.reduce((a, b) => a + b, 0);
    const sy = values.reduce((a, b) => a + b, 0);
    const sxy = x.reduce((acc, xi, i) => acc + xi * values[i], 0);
    const sx2 = x.reduce((acc, xi) => acc + xi * xi, 0);
    const den = (n * sx2) - (sx * sx);
    const m = den !== 0 ? (((n * sxy) - (sx * sy)) / den) : 0;
    const b = (sy - (m * sx)) / n;
    const out: number[] = [];
    for (let h = 1; h <= horizon; h++) {
      out.push(Math.max(0, (m * (n + h)) + b));
    }
    return out;
  }

  private generarEtiquetasFuturas(base: PrediccionSerie[], count: number): string[] {
    const last = base[base.length - 1]?.label || '';
    if (this.periodo === 'mes') {
      const m = last.match(/^(\d{4})-(\d{2})$/);
      if (m) {
        let y = Number(m[1]);
        let mm = Number(m[2]);
        const labels: string[] = [];
        for (let i = 0; i < count; i++) {
          mm += 1;
          if (mm > 12) {
            mm = 1;
            y += 1;
          }
          labels.push(`${y}-${String(mm).padStart(2, '0')}`);
        }
        return labels;
      }
    }
    if (this.periodo === 'dia') {
      const d = new Date(`${last}T00:00:00`);
      if (!Number.isNaN(d.getTime())) {
        const labels: string[] = [];
        for (let i = 1; i <= count; i++) {
          const nd = new Date(d);
          nd.setDate(d.getDate() + i);
          labels.push(`${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, '0')}-${String(nd.getDate()).padStart(2, '0')}`);
        }
        return labels;
      }
    }
    if (this.periodo === 'semana') {
      const rango = this.parseSemanaLabel(last);
      if (rango) {
        const labels: string[] = [];
        for (let i = 1; i <= count; i++) {
          const inicio = new Date(rango.inicio);
          inicio.setDate(inicio.getDate() + (i * 7));
          labels.push(this.labelSemanaDesdeInicio(inicio));
        }
        return labels;
      }
    }
    return Array.from({ length: count }, (_, i) => `Proy ${i + 1}`);
  }

  private parseFecha(label: string): Date | null {
    const m = label.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }

  private parseSemanaLabel(label: string): { inicio: Date; fin: Date } | null {
    const rangoTxt = label.match(/^(\d{4}-\d{2}-\d{2})\s*(?:a|-)\s*(\d{4}-\d{2}-\d{2})$/i);
    if (rangoTxt) {
      const inicio = this.parseFecha(rangoTxt[1]);
      const fin = this.parseFecha(rangoTxt[2]);
      if (inicio && fin) return { inicio, fin };
    }

    const iso = label.match(/^(\d{4})-W(\d{1,2})$/i);
    if (iso) {
      const year = Number(iso[1]);
      const week = Number(iso[2]);
      const inicio = this.isoWeekStart(year, week);
      const fin = new Date(inicio);
      fin.setDate(inicio.getDate() + 6);
      return { inicio, fin };
    }

    // No interpretar "YYYY-MM" (mes calendario) como semana ISO: chocaba con etiquetas de mes y podía reusar mal la UI.

    return null;
  }

  private isoWeekStart(year: number, week: number): Date {
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const day = jan4.getUTCDay() || 7;
    const mondayWeek1 = new Date(jan4);
    mondayWeek1.setUTCDate(jan4.getUTCDate() - day + 1);
    const target = new Date(mondayWeek1);
    target.setUTCDate(mondayWeek1.getUTCDate() + ((week - 1) * 7));
    return new Date(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate());
  }

  private labelSemanaDesdeInicio(inicio: Date): string {
    const year = inicio.getFullYear();
    const week = this.isoWeekNumber(inicio);
    return `${year}-W${String(week).padStart(2, '0')}`;
  }

  private isoWeekNumber(date: Date): number {
    const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNr = target.getUTCDay() || 7;
    target.setUTCDate(target.getUTCDate() + 4 - dayNr);
    const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
    return Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }

  private formatFechaCorta(date: Date): string {
    return new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: 'short' })
      .format(date)
      .replace('.', '')
      .replace(/\b([a-zñáéíóú])/g, (m) => m.toUpperCase());
  }

  private formatFechaCompleta(date: Date): string {
    return new Intl.DateTimeFormat('es-MX', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }).format(date);
  }

  private formatMesAnio(label: string): string {
    const m = /^(\d{4})-(\d{2})$/.exec(label);
    if (!m) return label;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return label;
    const d = new Date(year, month - 1, 1);
    const texto = new Intl.DateTimeFormat('es-MX', {
      month: 'long',
      year: 'numeric'
    }).format(d);
    return texto.replace(/\b([a-zñáéíóú])/g, (char) => char.toUpperCase());
  }

  private formatMesCorto(label: string): string {
    const m = /^(\d{4})-(\d{2})$/.exec(label);
    if (!m) return label;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) return label;
    const d = new Date(year, month - 1, 1);
    const texto = new Intl.DateTimeFormat('es-MX', {
      month: 'short'
    }).format(d);
    return texto
      .replaceAll('.', '')
      .replace(/\b([a-zñáéíóú])/g, (char) => char.toUpperCase());
  }

  private formatRangoSemanalCorto(inicio: Date, fin: Date): string {
    const diaIni = String(inicio.getDate()).padStart(2, '0');
    const diaFin = String(fin.getDate()).padStart(2, '0');
    const mismoMes = inicio.getMonth() === fin.getMonth() && inicio.getFullYear() === fin.getFullYear();
    const mismoAnio = inicio.getFullYear() === fin.getFullYear();

    const mesIni = new Intl.DateTimeFormat('es-MX', { month: 'short' })
      .format(inicio)
      .replaceAll('.', '')
      .replace(/\b([a-zñáéíóú])/g, (m) => m.toUpperCase());
    const mesFin = new Intl.DateTimeFormat('es-MX', { month: 'short' })
      .format(fin)
      .replaceAll('.', '')
      .replace(/\b([a-zñáéíóú])/g, (m) => m.toUpperCase());

    if (mismoMes) {
      return `${diaIni}-${diaFin} ${mesIni} ${inicio.getFullYear()}`;
    }
    if (mismoAnio) {
      return `${diaIni} ${mesIni} - ${diaFin} ${mesFin} ${inicio.getFullYear()}`;
    }
    return `${diaIni} ${mesIni} ${inicio.getFullYear()} - ${diaFin} ${mesFin} ${fin.getFullYear()}`;
  }

  private formatRangoSemanalUltraCorto(inicio: Date, fin: Date): string {
    const diaIni = String(inicio.getDate()).padStart(2, '0');
    const diaFin = String(fin.getDate()).padStart(2, '0');
    const mismoMes = inicio.getMonth() === fin.getMonth() && inicio.getFullYear() === fin.getFullYear();
    const mesIni = new Intl.DateTimeFormat('es-MX', { month: 'short' })
      .format(inicio)
      .replace('.', '')
      .replace(/\b([a-zñáéíóú])/g, (m) => m.toUpperCase());
    const mesFin = new Intl.DateTimeFormat('es-MX', { month: 'short' })
      .format(fin)
      .replace('.', '')
      .replace(/\b([a-zñáéíóú])/g, (m) => m.toUpperCase());
    if (mismoMes) return `${diaIni}-${diaFin} ${mesIni}`;
    return `${diaIni} ${mesIni}-${diaFin} ${mesFin}`;
  }

  private formatFechaDiaUltraCorta(date: Date): string {
    const day = String(date.getDate()).padStart(2, '0');
    const mes = new Intl.DateTimeFormat('es-MX', { month: 'short' })
      .format(date)
      .replaceAll('.', '')
      .replace(/\b([a-zñáéíóú])/g, (m) => m.toUpperCase());
    return `${day} ${mes}`;
  }

  private actualizarModoEtiquetas(): void {
    if (globalThis.window === undefined) {
      this.etiquetasCompactas = false;
      return;
    }
    this.etiquetasCompactas = globalThis.window.innerWidth <= 768;
  }

  get pieStyle(): string {
    const part = this.participacionProductos;
    if (!part.length) return 'conic-gradient(#cfd8dc 0deg 360deg)';

    const totalUnidades = part.reduce((acc, p) => acc + (Number(p.unidades) || 0), 0);
    const useUnidades = totalUnidades > 0;
    let start = 0;
    const slices: string[] = [];
    part.forEach((p, idx) => {
      const pct = useUnidades
        ? ((Number(p.unidades) || 0) / totalUnidades) * 100
        : (Number(p.porcentaje) || 0);
      const sweep = pct * 3.6;
      const end = Math.min(360, start + sweep);
      slices.push(`${this.colorParticipacion(idx)} ${start}deg ${end}deg`);
      start = end;
    });
    if (start < 360) slices.push(`#cfd8dc ${start}deg 360deg`);
    return `conic-gradient(${slices.join(', ')})`;
  }
  // ── Escala canónica ──
  // scaleMaxY: usamos el valor predicho (xt) como referencia del 80% del eje Y.
  // Esto garantiza que el punto de predicción siempre sea visible dentro del área,
  // y la curva más allá simplemente sale por arriba (clipPath la recorta).
  private get _scaleMaxY(): number {
    const xt = Number(this.modeloXt || 0);
    if (xt <= 0) return Math.max(...(this.curvePointsModelo.map(p => p.y)), 1);
    return xt / 0.80; // xt ocupa el 80% vertical → hay margen arriba
  }

  private get _scaleMaxX(): number {
    return Math.max(...(this.curvePointsModelo.map(p => p.x)), 1);
  }

  private _svgX(t: number): number { return 50 + (t / this._scaleMaxX) * 700; }
  private _svgY(v: number): number { return 350 - Math.min((v / this._scaleMaxY) * 300, 310); }

  get curvePath(): string {
    const points = this.curvePointsModelo;
    if (!points.length) return '';
    return points.map((p, i) =>
      `${i === 0 ? 'M' : 'L'} ${this._svgX(p.x).toFixed(1)} ${this._svgY(p.y).toFixed(1)}`
    ).join(' ');
  }

  get areaPath(): string {
    const points = this.curvePointsModelo;
    if (!points.length) return '';
    const pts = points.map(p =>
      `L ${this._svgX(p.x).toFixed(1)} ${this._svgY(p.y).toFixed(1)}`
    ).join(' ');
    return `M 50 350 L 50 ${this._svgY(points[0].y).toFixed(1)} ${pts} L ${this._svgX(points[points.length-1].x).toFixed(1)} 350 Z`;
  }

  get startX(): number { return 50; }

  get startY(): number {
    return this.curvePointsModelo.length ? this._svgY(Number(this.modeloX0 || 0)) : 350;
  }

  get endX(): number {
    return this.curvePointsModelo.length ? this._svgX(this.modeloTpReal) : 750;
  }

  get endY(): number {
    return this.curvePointsModelo.length ? this._svgY(Number(this.modeloXt || 0)) : 350;
  }
  // ── Posiciones dinámicas para etiquetas de ejes (en %) ──
/** Posición Y para etiqueta MAX (arriba) en el contenedor */
get labelYMaxPct(): number {
  // En el SVG: y=50 es arriba. Contenedor: 400px alto.
  // (50 / 400) * 100 = 12.5%
  return 12.5;
}

/** Posición Y para etiqueta MID (medio) */
get labelYMidPct(): number {
  // En el SVG: y=200 es medio. (200 / 400) * 100 = 50%
  return 50;
}

/** Posición Y para etiqueta MIN (abajo) */
get labelYMinPct(): number {
  // En el SVG: y=350 es abajo. (350 / 400) * 100 = 87.5%
  return 87.5;
}

/** Posición X para etiqueta START (izquierda) */
get labelXStartPct(): number {
  // En el SVG: x=50 es inicio. (50 / 800) * 100 = 6.25%
  return 6.25;
}

/** Posición X para etiqueta MID (centro) */
get labelXMidPct(): number {
  // En el SVG: x=400 es centro. (400 / 800) * 100 = 50%
  return 50;
}

/** Posición X para etiqueta END (derecha) */
get labelXEndPct(): number {
  // En el SVG: x=750 es fin. (750 / 800) * 100 = 93.75%
  return 93.75;
}

// ── Ticks del eje Y dentro del SVG (coordenadas SVG) ──
// El área de dibujo va de y=50 (top) a y=350 (bottom), altura útil = 300px
// maxY = valor máximo de la curva
get svgYTicks(): Array<{ y: number; label: string }> {
  const pts = this.curvePointsModelo;
  if (!pts.length) return [];
  const maxY  = this._scaleMaxY;
  const steps = 4;
  const out: Array<{ y: number; label: string }> = [];
  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const val  = maxY * frac;
    const svgY = 350 - frac * 300;
    let label: string;
    if (val >= 1_000_000)   label = (val / 1_000_000).toFixed(1) + 'M';
    else if (val >= 10_000) label = Math.round(val / 1000) + 'k';
    else if (val >= 1_000)  label = (val / 1000).toFixed(1) + 'k';
    else if (val >= 100)    label = Math.round(val).toString();
    else if (val >= 10)     label = val.toFixed(1);
    else                    label = val.toFixed(val === 0 ? 0 : 1);
    out.push({ y: Number(svgY.toFixed(1)), label });
  }
  return out;
}

get svgXTicks(): Array<{ x: number; label: string }> {
  const pts = this.curvePointsModelo;
  if (!pts.length) return [];
  const maxX   = this._scaleMaxX;
  const steps  = 5;
  const tpDays = Math.round(this.modeloTpReal);
  const out: Array<{ x: number; label: string }> = [];
  for (let i = 0; i <= steps; i++) {
    const frac    = i / steps;
    const valDays = Math.round(maxX * frac);
    const svgX    = 50 + frac * 700;
    if (valDays === tpDays) continue;
    out.push({ x: Number(svgX.toFixed(1)), label: valDays + 'd' });
  }
  return out;
}

}