import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { AdminService, MonitoreoBDResponse } from '../../../services/admin.service';

interface MetricItem {
  label: string;
  value: string;
  sub: string;
  status: 'ok' | 'warn' | 'danger' | 'accent';
}

interface TablaStat {
  tabla: string;
  esquema: string;
  filas: number;
  lecturas: number;
  escrituras: number;
}

interface SaludItem {
  label: string;
  valor: string;
  estado: 'ok' | 'warn';
}

interface LogItem {
  hora: string;
  esquema: string;
  operacion: string;
  duracionMs: number;
}

@Component({
  selector: 'app-monitoreo-bd',
  standalone: true,
  imports: [CommonModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './monitoreo-bd.component.html',
  styleUrl: './monitoreo-bd.component.css',
})
export class MonitoreoBdComponent implements OnInit, OnDestroy {
  private readonly adminService = inject(AdminService);

  loading = true;
  error = '';
  live = true;
  ultimaActualizacion = new Date();
  intervalo = 15;
  motor = '-';

  latenciaMs = 48;
  conexiones = 12;
  conexionesMax = 100;
  opsSeg = 214;
  cacheHit = 97;
  bloqueos = 0;

  metrics: MetricItem[] = [];
  tablas: TablaStat[] = [];
  salud: SaludItem[] = [];
  logs: LogItem[] = [];
  esquemaFiltro = '';
  tablaFiltro = '';
  logFiltro = '';
  umbralLatenciaWarn = 70;
  umbralLatenciaDanger = 120;
  umbralLogWarn = 200;
  umbralLogDanger = 500;
  private readonly sessionKey = 'admin_monitoreo_bd_ui_v1';

  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    this.hidratarPreferencias();
    this.refresh();
    this.timer = setInterval(() => {
      if (this.live) this.refresh();
    }, this.intervalo * 1000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  toggleLive(): void {
    this.live = !this.live;
    this.persistirPreferencias();
  }

  refresh(): void {
    this.error = '';
    this.adminService.getMonitoreoBD().subscribe({
      next: (res) => {
        this.loading = false;
        if (!res?.ok) {
          this.error = 'No se pudo consultar el monitoreo de base de datos.';
          return;
        }
        this.applyResponse(res);
      },
      error: () => {
        this.loading = false;
        this.error = 'Error al consultar métricas reales de la base de datos.';
      },
    });
  }

  pctConexiones(): number {
    return Math.round((this.conexiones / this.conexionesMax) * 100);
  }

  estadoDuracion(duracionMs: number): 'ok' | 'warn' | 'danger' {
    if (duracionMs > this.umbralLogDanger) return 'danger';
    if (duracionMs > this.umbralLogWarn) return 'warn';
    return 'ok';
  }

  actividadPct(lecturas: number): number {
    const max = Math.max(...this.tablas.map((t) => t.lecturas), 1);
    return Math.round((lecturas / max) * 100);
  }

  get esquemasDisponibles(): string[] {
    return Array.from(new Set(this.tablas.map((t) => t.esquema))).sort((a, b) => a.localeCompare(b));
  }

  get tablasDisponibles(): string[] {
    return Array.from(new Set(this.tablasFiltradasPorEsquema.map((t) => t.tabla))).sort((a, b) => a.localeCompare(b));
  }

  get tablasFiltradasPorEsquema(): TablaStat[] {
    if (!this.esquemaFiltro) return this.tablas;
    return this.tablas.filter((t) => t.esquema === this.esquemaFiltro);
  }

  get tablasFiltradas(): TablaStat[] {
    if (!this.tablaFiltro) return this.tablasFiltradasPorEsquema;
    return this.tablasFiltradasPorEsquema.filter((t) => t.tabla === this.tablaFiltro);
  }

  get logsFiltrados(): LogItem[] {
    const q = this.logFiltro.trim().toLowerCase();
    if (!q) return this.logs;
    return this.logs.filter((l) => l.operacion.toLowerCase().includes(q) || l.esquema.toLowerCase().includes(q));
  }

  onCambioEsquema(): void {
    this.tablaFiltro = '';
    this.persistirPreferencias();
  }

  onEsquemaInput(event: Event): void {
    this.esquemaFiltro = (event.target as HTMLSelectElement).value || '';
    this.onCambioEsquema();
  }

  onTablaInput(event: Event): void {
    this.tablaFiltro = (event.target as HTMLSelectElement).value || '';
    this.persistirPreferencias();
  }

  onLogFiltroInput(event: Event): void {
    this.logFiltro = (event.target as HTMLInputElement).value || '';
    this.persistirPreferencias();
  }

  onUmbralLatenciaWarnInput(event: Event): void {
    const n = Number((event.target as HTMLInputElement).value);
    this.umbralLatenciaWarn = Number.isFinite(n) && n > 0 ? n : 70;
    this.persistirPreferencias();
  }

  onUmbralLogWarnInput(event: Event): void {
    const n = Number((event.target as HTMLInputElement).value);
    this.umbralLogWarn = Number.isFinite(n) && n > 0 ? n : 200;
    this.persistirPreferencias();
  }

  exportarSnapshotCsv(): void {
    const rows: string[] = [];
    rows.push('BLOQUE,CLAVE,VALOR');
    rows.push(`METRICA,LatenciaMs,${this.latenciaMs}`);
    rows.push(`METRICA,Conexiones,${this.conexiones}`);
    rows.push(`METRICA,ConexionesMax,${this.conexionesMax}`);
    rows.push(`METRICA,OpsSeg,${this.opsSeg}`);
    rows.push(`METRICA,CacheHit,${this.cacheHit}`);
    rows.push(`METRICA,Bloqueos,${this.bloqueos}`);
    rows.push('');
    rows.push('TABLAS,Esquema,Tabla,Filas,Lecturas,Escrituras');
    for (const t of this.tablasFiltradas) {
      rows.push(`TABLA,${t.esquema},${t.tabla},${t.filas},${t.lecturas},${t.escrituras}`);
    }
    rows.push('');
    rows.push('LOGS,Hora,Esquema,Operacion,DuracionMs,Estado');
    for (const l of this.logsFiltrados) {
      rows.push(`LOG,${l.hora},${l.esquema},"${l.operacion.replaceAll('"', '""')}",${l.duracionMs},${this.estadoDuracion(l.duracionMs)}`);
    }
    const csv = rows.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = globalThis.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `monitoreo_bd_${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}.csv`;
    a.click();
    globalThis.URL.revokeObjectURL(url);
  }

  private rebuildMetrics(): void {
    this.metrics = [
      { label: 'Estado PostgreSQL', value: 'Conectada', sub: this.motor, status: 'ok' },
      { label: 'Latencia', value: `${this.latenciaMs} ms`, sub: 'RTT backend a BD', status: this.latenciaMs > this.umbralLatenciaWarn ? 'warn' : 'ok' },
      { label: 'Conexiones', value: `${this.conexiones}/${this.conexionesMax}`, sub: `${this.pctConexiones()}% en uso`, status: this.pctConexiones() > 75 ? 'warn' : 'ok' },
      { label: 'Ops / seg', value: `${this.opsSeg}`, sub: 'promedio 15s', status: 'accent' },
      { label: 'Cache hit', value: `${this.cacheHit}%`, sub: 'buffer cache', status: this.cacheHit < 95 ? 'warn' : 'ok' },
      { label: 'Bloqueos', value: this.bloqueos ? `${this.bloqueos}` : 'Ninguno', sub: 'deadlocks activos', status: this.bloqueos ? 'danger' : 'ok' },
    ];
  }

  private applyResponse(res: MonitoreoBDResponse): void {
    this.motor = res.motor || '-';
    this.latenciaMs = Number(res.latencia_ms || 0);
    this.conexiones = Number(res.conexiones || 0);
    this.conexionesMax = Number(res.conexiones_max || 100);
    this.opsSeg = Number(res.ops_seg || 0);
    this.cacheHit = Number(res.cache_hit || 0);
    this.bloqueos = Number(res.bloqueos || 0);
    this.ultimaActualizacion = res.ts ? new Date(res.ts) : new Date();

    this.tablas = Array.isArray(res.tablas)
      ? res.tablas.map((t) => ({
          tabla: t.tabla,
          esquema: t.esquema,
          filas: Number(t.filas || 0),
          lecturas: Number(t.lecturas || 0),
          escrituras: Number(t.escrituras || 0),
        }))
      : [];

    this.salud = Array.isArray(res.salud)
      ? res.salud.map((s) => ({
          label: s.label,
          valor: s.valor,
          estado: s.estado,
        }))
      : [];

    this.logs = Array.isArray(res.logs)
      ? res.logs.map((l) => ({
          hora: l.hora,
          esquema: l.esquema,
          operacion: l.operacion,
          duracionMs: Number(l.duracion_ms || 0),
        }))
      : [];

    this.rebuildMetrics();
  }

  private persistirPreferencias(): void {
    try {
      const payload = {
        live: this.live,
        esquemaFiltro: this.esquemaFiltro,
        tablaFiltro: this.tablaFiltro,
        logFiltro: this.logFiltro,
        umbralLatenciaWarn: this.umbralLatenciaWarn,
        umbralLogWarn: this.umbralLogWarn,
      };
      sessionStorage.setItem(this.sessionKey, JSON.stringify(payload));
    } catch {
      // ignore quota/storage errors
    }
  }

  private hidratarPreferencias(): void {
    try {
      const raw = sessionStorage.getItem(this.sessionKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        live?: boolean;
        esquemaFiltro?: string;
        tablaFiltro?: string;
        logFiltro?: string;
        umbralLatenciaWarn?: number;
        umbralLogWarn?: number;
      };
      this.live = typeof parsed.live === 'boolean' ? parsed.live : this.live;
      this.esquemaFiltro = parsed.esquemaFiltro ?? this.esquemaFiltro;
      this.tablaFiltro = parsed.tablaFiltro ?? this.tablaFiltro;
      this.logFiltro = parsed.logFiltro ?? this.logFiltro;
      if (typeof parsed.umbralLatenciaWarn === 'number' && parsed.umbralLatenciaWarn > 0) {
        this.umbralLatenciaWarn = parsed.umbralLatenciaWarn;
      }
      if (typeof parsed.umbralLogWarn === 'number' && parsed.umbralLogWarn > 0) {
        this.umbralLogWarn = parsed.umbralLogWarn;
      }
    } catch {
      // ignore invalid session payload
    }
  }
}

