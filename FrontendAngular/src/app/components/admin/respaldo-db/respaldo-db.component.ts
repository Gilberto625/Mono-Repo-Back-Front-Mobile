import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { AdminService, RespaldoBDItem, RespaldoBDStatus, RespaldoTablaItem } from '../../../services/admin.service';

@Component({
  selector: 'app-respaldo-db',
  standalone: true,
  imports: [CommonModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './respaldo-db.component.html',
  styleUrl: './respaldo-db.component.css'
})
export class RespaldoDbComponent implements OnInit {
  private readonly adminService = inject(AdminService);

  loading = true;
  creandoRespaldo = false;
  cargandoTablas = false;
  error = '';
  mensaje = '';

  status: RespaldoBDStatus | null = null;
  respaldos: RespaldoBDItem[] = [];
  respaldoLogicoKind: 'citas' | 'compras' | 'inventario' | 'servicios' = 'citas';
  creandoRespaldoLogico = false;
  tablas: RespaldoTablaItem[] = [];
  schemaFiltro: 'negocio' | 'stg' | 'rpt' | '' = '';
  tablaFiltro = '';
  filtrosAplicados = false;

  seleccionadas = new Set<string>();

  ngOnInit(): void {
    this.cargarEstado();
  }

  private tableKey(schema: string, table: string): string {
    return `${schema}.${table}`;
  }

  private fromKey(key: string): { schema: string; table: string } {
    const [schema, table] = key.split('.', 2);
    return { schema, table };
  }

  cargarEstado(forceRefresh = false): void {
    this.loading = true;
    this.error = '';
    this.mensaje = '';
    this.adminService.getRespaldoBDStatus(forceRefresh).subscribe({
      next: (res) => {
        this.loading = false;
        if (!res?.ok) {
          this.error = 'No se pudo cargar el estado de respaldo.';
          return;
        }
        this.status = res;
        this.respaldos = res.respaldos || [];
      },
      error: (err) => {
        this.loading = false;
        const s = typeof err?.status === 'number' ? err.status : 0;
        if (s === 0 || s === 502 || s === 503 || s === 504) {
          this.error =
            'El servidor tardó en responder o se reinició (p. ej. tras un respaldo grande). Espera unos segundos y vuelve a pulsar «Actualizar estado».';
          return;
        }
        this.error = err?.error?.error || 'Error de conexión con el backend.';
      }
    });
  }

  cargarTablas(): void {
    this.cargandoTablas = true;
    this.error = '';
    const schema = (this.schemaFiltro || '').trim() || undefined;
    if (!schema) {
      this.cargandoTablas = false;
      this.filtrosAplicados = false;
      this.tablas = [];
      return;
    }
    this.adminService.getRespaldoTablas(schema).subscribe({
      next: (res) => {
        this.cargandoTablas = false;
        this.tablas = Array.isArray(res?.tables) ? res.tables : [];
        this.filtrosAplicados = true;
      },
      error: (err) => {
        this.cargandoTablas = false;
        this.filtrosAplicados = false;
        this.error = err?.error?.error || 'No se pudo cargar la lista de tablas.';
      }
    });
  }

  toggleTabla(item: RespaldoTablaItem): void {
    const key = this.tableKey(item.schema, item.table);
    if (this.seleccionadas.has(key)) this.seleccionadas.delete(key);
    else this.seleccionadas.add(key);
  }

  seleccionarTodasVisibles(): void {
    for (const item of this.tablasFiltradas) {
      this.seleccionadas.add(this.tableKey(item.schema, item.table));
    }
  }

  invertirSeleccionVisible(): void {
    for (const item of this.tablasFiltradas) {
      const key = this.tableKey(item.schema, item.table);
      if (this.seleccionadas.has(key)) this.seleccionadas.delete(key);
      else this.seleccionadas.add(key);
    }
  }

  limpiarSeleccion(): void {
    this.seleccionadas.clear();
  }

  onSchemaChange(): void {
    this.tablaFiltro = '';
    this.seleccionadas.clear();
    this.filtrosAplicados = false;
    this.tablas = [];
  }

  crearRespaldo(): void {
    this.creandoRespaldo = true;
    this.error = '';
    this.mensaje = '';

    const seleccion = Array.from(this.seleccionadas).map((k) => this.fromKey(k));
    this.adminService.crearRespaldoBD(seleccion, (this.schemaFiltro || '').trim() || undefined).subscribe({
      next: (response: any) => {
        this.creandoRespaldo = false;
        const blob = response?.body as Blob | null;
        if (!blob) {
          this.error = 'No se recibió archivo para descarga.';
          return;
        }
        const dispo = String(response?.headers?.get?.('content-disposition') || '');
        const re = /filename="?([^";]+)"?/i;
        const match = re.exec(dispo);
        const filename = match?.[1] || `respaldo_completo_${this.tsNow()}.zip`;
        const url = globalThis.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        globalThis.URL.revokeObjectURL(url);
        this.mensaje = 'Respaldo completo descargado.';
        this.cargarEstado(true);
      },
      error: (err) => {
        this.creandoRespaldo = false;
        this.setBackupErrorMessage(err, 'No se pudo generar el respaldo.');
      }
    });
  }

  crearRespaldoLogico(): void {
    this.creandoRespaldoLogico = true;
    this.error = '';
    this.mensaje = '';
    this.adminService.crearRespaldoLogicoBD(this.respaldoLogicoKind).subscribe({
      next: (response: any) => {
        this.creandoRespaldoLogico = false;
        const blob = response?.body as Blob | null;
        if (!blob) {
          this.error = 'No se recibió archivo para descarga.';
          return;
        }
        const dispo = String(response?.headers?.get?.('content-disposition') || '');
        const re = /filename="?([^";]+)"?/i;
        const match = re.exec(dispo);
        const filename = match?.[1] || `respaldo_logico_${this.respaldoLogicoKind}_${this.tsNow()}.zip`;
        const url = globalThis.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        globalThis.URL.revokeObjectURL(url);
        this.mensaje = `Respaldo lógico descargado (${this.respaldoLogicoKind}).`;
        this.cargarEstado(true);
      },
      error: (err) => {
        this.creandoRespaldoLogico = false;
        this.setBackupErrorMessage(err, 'No se pudo generar el respaldo lógico.');
      }
    });
  }

  get respaldosCompletos(): RespaldoBDItem[] {
    return (this.respaldos || []).filter((r) => !String(r.archivo || '').startsWith('respaldo_logico_'));
  }

  get respaldosLogicos(): RespaldoBDItem[] {
    return (this.respaldos || []).filter((r) => String(r.archivo || '').startsWith('respaldo_logico_'));
  }

  descargarRespaldo(item: RespaldoBDItem): void {
    this.error = '';
    this.mensaje = '';
    this.adminService.descargarRespaldoBD(item.archivo).subscribe({
      next: (response) => {
        const blob = response.body;
        if (!blob) {
          this.error = 'No se recibió archivo para descarga.';
          return;
        }
        const url = globalThis.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = item.archivo;
        link.click();
        globalThis.URL.revokeObjectURL(url);
      },
      error: (err) => {
        this.error = err?.error?.error || 'No se pudo descargar el respaldo.';
      }
    });
  }

  exportarCSV(item: RespaldoTablaItem): void {
    this.error = '';
    this.mensaje = '';
    this.adminService.exportarTablaCSV(item.schema, item.table).subscribe({
      next: (res) => {
        if (!res?.ok || !res.content_base64) {
          this.error = 'No se pudo exportar la tabla.';
          return;
        }
        const bytes = this.base64ToUint8Array(res.content_base64);
        // Cast explícito para evitar incompatibilidades de tipos con SharedArrayBuffer.
        const blob = new Blob([bytes as unknown as BlobPart], { type: 'text/csv;charset=utf-8;' });
        const url = globalThis.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = res.filename || `${item.schema}.${item.table}.csv`;
        a.click();
        globalThis.URL.revokeObjectURL(url);
        const filasTxt = Number.isFinite(res.row_count as number) ? String(res.row_count) : 'N/D';
        const colsTxt = Number.isFinite(res.column_count as number) ? String(res.column_count) : 'N/D';
        this.mensaje = `CSV exportado correctamente (${item.schema}.${item.table}) con ${filasTxt} filas y ${colsTxt} columnas.`;
      },
      error: (err) => {
        this.error = err?.error?.error || 'No se pudo exportar CSV.';
      }
    });
  }

  get tablasFiltradas(): RespaldoTablaItem[] {
    const q = this.tablaFiltro.trim().toLowerCase();
    if (!q) return this.tablas;
    // tablaFiltro ahora es el nombre exacto de tabla (select).
    return this.tablas.filter((t) => String(t.table || '').toLowerCase() === q);
  }

  get todasVisiblesSeleccionadas(): boolean {
    const visibles = this.tablasFiltradas;
    if (!visibles.length) return false;
    return visibles.every((item) => this.seleccionadas.has(this.tableKey(item.schema, item.table)));
  }

  toggleSeleccionMaestra(): void {
    if (this.todasVisiblesSeleccionadas) {
      for (const item of this.tablasFiltradas) {
        this.seleccionadas.delete(this.tableKey(item.schema, item.table));
      }
      return;
    }
    for (const item of this.tablasFiltradas) {
      this.seleccionadas.add(this.tableKey(item.schema, item.table));
    }
  }

  formatFecha(valor: string | null | undefined): string {
    if (!valor) return 'Sin ejecuciones';
    const d = new Date(valor);
    if (Number.isNaN(d.getTime())) return 'Fecha inválida';
    return d.toLocaleString('es-MX');
  }

  formatSoloFecha(valor: string | null | undefined): string {
    if (!valor) return '-';
    const d = new Date(valor);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('es-MX');
  }

  formatSoloHora(valor: string | null | undefined): string {
    if (!valor) return '-';
    const d = new Date(valor);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleTimeString('es-MX');
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.codePointAt(i) || 0;
    }
    return bytes;
  }

  private tsNow(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  /** Con responseType blob, el cuerpo de error 500 suele ser JSON dentro de un Blob. */
  private setBackupErrorMessage(err: unknown, fallback: string): void {
    const e = err as { error?: unknown; message?: string };
    const body = e?.error;
    if (body instanceof Blob) {
      void body
        .text()
        .then((text) => {
          try {
            const j = JSON.parse(text) as { error?: string; detail?: string };
            const msg = j?.error || (typeof j?.detail === 'string' ? j.detail : '');
            this.error = msg.trim() || text.slice(0, 500) || fallback;
          } catch {
            this.error = text?.trim() ? text.slice(0, 500) : fallback;
          }
        })
        .catch(() => {
          this.error = fallback;
        });
      return;
    }
    if (body && typeof body === 'object' && 'error' in body) {
      const msg = (body as { error?: string }).error;
      this.error = typeof msg === 'string' && msg.trim() ? msg : fallback;
      return;
    }
    const msg = e?.message;
    this.error = typeof msg === 'string' && msg.trim() ? msg : fallback;
  }
}

