// admin.service.ts
// Servicio para todas las operaciones de administración

import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Observable, BehaviorSubject, of, throwError, timer } from 'rxjs';
import { map, tap, catchError, switchMap } from 'rxjs/operators';
import { environment } from '../../environments/environment';

// Interfaces
/** Respuesta de `GET /admin/sillas/` (lista y formularios de empleado). */
export interface SillaAdmin {
  id: number;
  numero: string;
  nombre: string;
  activa: boolean;
  ocupada?: boolean;
  ocupada_por?: string;
  ocupada_por_empleado_id?: number | null;
}

export interface MarcaAdmin {
  id: number;
  nombre: string;
  activa: boolean;
}

export interface Empleado {
  id: number;
  email: string;
  username: string;
  nombre: string;
  apellido: string;
  telefono: string;
  rol: string;
  activo: boolean;
  verificado?: boolean;
  date_joined?: string;
  en_vacaciones?: boolean;
  en_descanso?: boolean;
  especialidades?: string;
  horario_trabajo?: string;
  horario_display?: string;
  bio?: string;
  avatar_url?: string;
  silla_asignada?: string;
  fecha_nacimiento?: string;
  dias_libres?: string;
  periodos_vacaciones?: string;
}

export interface Servicio {
  id: number;
  nombre: string;
  descripcion: string;
  precio: number;
  duracion_minutos: number;
  categoria: string;
  imagen_url: string;
  activo: boolean;
  popular: boolean;
}

export interface Producto {
  id: number;
  nombre: string;
  marca?: string;
  descripcion: string;
  peso_volumen?: string;
  precio: number;
  categoria: string;
  stock: number;
  stock_minimo: number;
  imagen_url: string;
  activo: boolean;
  destacado: boolean;
  nuevo: boolean;
}

/** Parámetros de `GET /admin/productos/` (catálogo paginado; no usar con `soloActivos`). */
export interface ProductosCatalogQuery {
  page: number;
  perPage: number;
  q: string;
  categoria: string;
  marca: string;
  estado: string;
}

export interface ProductosCatalogBootstrap {
  query: ProductosCatalogQuery;
  productos: Producto[];
  total: number;
  total_pages: number;
  stats: {
    total_filtrado?: number;
    disponibles: number;
    stock_bajo: number;
    agotados: number;
  };
  marcas_filtro: string[];
}

export interface PromocionAdmin {
  id: number;
  nombre: string;
  descripcion: string;
  tipo_descuento: 'porcentaje' | 'monto_fijo' | '2x1' | 'producto_gratis';
  aplica_en: 'servicios' | 'productos' | 'ambos';
  valor_descuento: number;
  codigo: string;
  fecha_inicio: string;
  fecha_fin: string;
  solo_clientes_nuevos: boolean;
  requiere_compra_minima: boolean;
  monto_compra_minima: number | null;
  limite_usos: number | null;
  usos_actuales: number;
  activa: boolean;
  estado: 'activa' | 'programada' | 'finalizada' | 'pausada';
}

export interface EstadisticasPromociones {
  promociones_activas: number;
  promociones_programadas: number;
  promociones_finalizadas: number;
  promociones_pausadas: number;
  usos_total: number;
  descuentos_aplicados_mes: number;
}

export interface DashboardStats {
  ventas_dia: number;
  ventas_ayer?: number;
  porcentaje_ventas_vs_ayer?: number | null;
  citas_hoy: number;
  citas_pendientes: number;
  barberos_activos: number;
  barberos_en_descanso: number;
  productos_stock_bajo: number;
  total_clientes: number;
  servicios_activos: number;
  productos_activos: number;
}

export interface TopServicioHoy {
  id: number;
  nombre: string;
  precio: string;
  cantidad: number;
  total: string;
}

export interface HorarioDemanda {
  hora: string;
  porcentaje: number;
}

/** Un día en horarios_por_dia (índice 0=Lunes .. 6=Domingo). */
export interface HorarioDiaConfig {
  abierto: boolean;
  apertura: string;
  cierre: string;
}

export interface Configuracion {
  nombre_negocio: string;
  direccion: string;
  telefono: string;
  email_contacto: string;
  horario_apertura: string;
  horario_cierre: string;
  porcentaje_anticipo: number;
  banco_nombre: string;
  banco_cuenta: string;
  banco_titular: string;
  tiempo_espera_maximo: number;
  citas_penalizacion: number;
  /** Opcional: horarios por día (7 elementos, 0=Lunes .. 6=Domingo). */
  horarios_por_dia?: HorarioDiaConfig[];
  // Redes sociales
  facebook_url: string;
  instagram_url: string;
  x_url: string;
  tiktok_url: string;
  whatsapp_url: string;
  // Mapas
  google_maps_url: string;
  apple_maps_url: string;
  costos_envio?: {
    recoger_local?: number;
    moto_mandado?: number;
    paqueteria?: number;
  };
  paqueterias_disponibles?: string[];
  pago_efectivo_activo?: boolean;
  pago_tarjeta_activo?: boolean;
  pago_transferencia_activo?: boolean;
  clip_habilitado?: boolean;
  clip_url?: string;
  clip_api_key_prueba_masked?: string;
  clip_api_secret_prueba_configurada?: boolean;
  clip_api_key_masked?: string;
  clip_api_secret_configurada?: boolean;
  clip_auth_token_configurada?: boolean;
  // Logo
  logo_tipo?: string;
  logo_texto?: string;
  logo_texto_acento?: string;
  logo_url?: string;
}

export interface RespaldoBDItem {
  archivo: string;
  size_bytes: number;
  size_humano: string;
  fecha: string;
}

export interface RespaldoBDStatus {
  ok: boolean;
  db_vendor: string;
  db_version: string;
  db_name: string;
  db_size_bytes: number;
  db_size_humano: string;
  ultima_ejecucion: string | null;
  respaldos: RespaldoBDItem[];
}

export interface RespaldoTablaItem {
  schema: string;
  table: string;
  rows_est: number;
}

export interface PrediccionSerie {
  label: string;
  valor: number;
}

export interface PrediccionVentasResponse {
  ok: boolean;
  modo: 'real' | 'prueba';
  fuente: string;
  meta?: {
    subcategoria_alias?: string;
    explicacion?: string;
  };
  filtros: {
    categorias: Array<{ codigo: string; nombre: string }>;
    subcategorias: Array<{ id: number; nombre: string }>;
    productos: Array<{ id: number; nombre: string }>;
  };
  seleccion: {
    categoria: string;
    subcategoria_id: number | null;
    producto_id: number | null;
    producto_nombre: string;
  };
  ventas: {
    dia: PrediccionSerie[];
    semana: PrediccionSerie[];
    mes: PrediccionSerie[];
  };
  ventas_rango?: {
    desde: string | null;
    hasta: string | null;
    dia: PrediccionSerie[];
  };
  kpis_ventas?: {
    scope: string;
    desde: string;
    hasta: string;
    unidades_vendidas: number;
    tickets_entregados: number;
    promedio_diario: number;
  };
  prediccion: {
    modelo_recomendado: string;
    lineal: number[];
    exponencial: number[];
    pendiente_lineal: number;
    k_exponencial: number;
    venta_proyectada_mes_siguiente: number;
    tendencia: string;
    punto_reorden_sugerido: number;
    stock_actual?: number;
    stock_minimo?: number;
    backtesting?: {
      muestras: number;
      mae: number | null;
      mape: number | null;
      precision_porcentaje: number | null;
    };
  };
  prediccion_crecimiento?: {
    scope: 'dia' | 'mes';
    ley?: string;
    k?: number;
    base?: {
      tipo: 'unidades_diarias' | 'totales_mensuales';
      valores: number[];
    };
    predicciones?: number[];
    venta_proyectada_siguientes_6_dias?: number;
    venta_proyectada_mes_siguiente?: number;
  };
  subcategoria: {
    prediccion_mes_siguiente: number;
    tendencia: string;
    producto_mas_vendido: {
      producto_id: number | null;
      nombre: string;
      unidades: number;
    };
    participacion_productos: Array<{
      producto_id: number;
      nombre: string;
      unidades: number;
      porcentaje: number;
    }>;
  };
  subcategoria_ventas?: {
    dia: PrediccionSerie[];
    semana: PrediccionSerie[];
    mes: PrediccionSerie[];
  };
  subcategoria_prediccion?: {
    lineal: number[];
    exponencial: number[];
    pendiente_lineal: number;
    k_exponencial: number;
    tendencia: string;
    venta_proyectada_mes_siguiente: number;
    backtesting?: {
      muestras: number;
      mae: number | null;
      mape: number | null;
      precision_porcentaje: number | null;
    };
  };
  productos_listado?: Array<{
    producto_id: number;
    producto_nombre: string;
    stock_disponible: number;
    ventas_totales: number;
  }>;
  justificacion_matematica?: {
    lineal?: string;
    exponencial?: string;
  };
}

export interface MonitoreoBDTabla {
  tabla: string;
  esquema: string;
  filas: number;
  lecturas: number;
  escrituras: number;
}

export interface MonitoreoBDSalud {
  label: string;
  valor: string;
  estado: 'ok' | 'warn';
}

export interface MonitoreoBDLog {
  hora: string;
  esquema: string;
  operacion: string;
  duracion_ms: number;
}

export interface MonitoreoBDResponse {
  ok: boolean;
  db_name: string;
  motor: string;
  latencia_ms: number;
  conexiones: number;
  conexiones_max: number;
  ops_seg: number;
  cache_hit: number;
  bloqueos: number;
  tablas: MonitoreoBDTabla[];
  salud: MonitoreoBDSalud[];
  logs: MonitoreoBDLog[];
  ts: string;
}

export interface ConfiguracionPublicaResponse {
  ok: boolean;
  configuracion: any;
}

@Injectable({
  providedIn: 'root'
})
export class AdminService {
  private readonly apiUrl = environment.apiUrl;

  // Subjects para datos en cache
  private readonly empleadosSubject = new BehaviorSubject<Empleado[]>([]);
  private readonly serviciosSubject = new BehaviorSubject<Servicio[]>([]);
  private readonly productosSubject = new BehaviorSubject<Producto[]>([]);
  private readonly sillasSubject = new BehaviorSubject<SillaAdmin[]>([]);
  private readonly configuracionPublicaSubject = new BehaviorSubject<ConfiguracionPublicaResponse | null>(null);
  private readonly marcasSubject = new BehaviorSubject<MarcaAdmin[]>([]);

  empleados$ = this.empleadosSubject.asObservable();
  servicios$ = this.serviciosSubject.asObservable();
  productos$ = this.productosSubject.asObservable();
  sillas$ = this.sillasSubject.asObservable();
  marcas$ = this.marcasSubject.asObservable();
  configuracionPublica$ = this.configuracionPublicaSubject.asObservable();

  private readonly configuracionPublicaSessionKey = 'public_config_contacto_v1';
  private readonly configuracionPublicaSessionMaxAgeMs = 10 * 60 * 1000;
  private configuracionPublicaInFlight = false;

  constructor(private readonly http: HttpClient) {
    const cached = this.readConfiguracionPublicaCache();
    if (cached) {
      this.configuracionPublicaSubject.next(cached);
    }
  }

  private readConfiguracionPublicaCache(): ConfiguracionPublicaResponse | null {
    try {
      const raw = sessionStorage.getItem(this.configuracionPublicaSessionKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { at?: number; value?: any };
      if (typeof parsed?.at !== 'number' || !parsed?.value) return null;
      if (Date.now() - parsed.at > this.configuracionPublicaSessionMaxAgeMs) return null;
      return parsed.value;
    } catch {
      return null;
    }
  }

  private writeConfiguracionPublicaCache(value: ConfiguracionPublicaResponse): void {
    try {
      sessionStorage.setItem(
        this.configuracionPublicaSessionKey,
        JSON.stringify({ at: Date.now(), value })
      );
    } catch {
      // ignore
    }
  }

  private getHeaders(): HttpHeaders {
    return new HttpHeaders({
      'Content-Type': 'application/json'
    });
  }

  // ============================================
  // DASHBOARD
  // ============================================
  getDashboardStats(): Observable<any> {
    return this.http.get(`${this.apiUrl}/admin/dashboard/`, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  // ============================================
  // EMPLEADOS
  // ============================================
  /** Última lista cargada en esta sesión (p. ej. volver desde editar sin esperar al servidor). */
  getEmpleadosCacheSnapshot(): Empleado[] {
    return this.empleadosSubject.value;
  }

  /** Misma clave y TTL que `empleados-lista` (sessionStorage). */
  private readonly empleadosListaSessionKey = 'admin_empleados_lista_v1';
  private readonly empleadosListaSessionMaxAgeMs = 3 * 60 * 1000;

  /**
   * Empleado desde la última lista (memoria o sessionStorage). Mismo shape que GET `/admin/empleados/:id/`.
   * Permite pintar editar al instante sin esperar red.
   */
  getEmpleadoFromListaCache(empleadoId: number): Empleado | null {
    const fromMem = this.empleadosSubject.value.find((e) => e.id === empleadoId);
    if (fromMem) {
      return { ...fromMem };
    }
    try {
      const raw = sessionStorage.getItem(this.empleadosListaSessionKey);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as { at?: number; empleados?: Empleado[] };
      if (!parsed?.empleados?.length || typeof parsed.at !== 'number') {
        return null;
      }
      if (Date.now() - parsed.at > this.empleadosListaSessionMaxAgeMs) {
        return null;
      }
      const hit = parsed.empleados.find((e) => e.id === empleadoId);
      return hit ? { ...hit } : null;
    } catch {
      return null;
    }
  }

  private readonly empleadoDetalleSessionPrefix = 'admin_empleado_detalle_v1_';
  private readonly empleadoDetalleSessionMaxAgeMs = 5 * 60 * 1000;

  /** Lista → navegación → detalle reciente (F5 / URL directa poco después). */
  getEmpleadoEdicionBootstrap(empleadoId: number): Empleado | null {
    const fromLista = this.getEmpleadoFromListaCache(empleadoId);
    if (fromLista) {
      return fromLista;
    }
    try {
      const raw = sessionStorage.getItem(`${this.empleadoDetalleSessionPrefix}${empleadoId}`);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as { at?: number; empleado?: Empleado };
      if (!parsed?.empleado || typeof parsed.at !== 'number') {
        return null;
      }
      if (Date.now() - parsed.at > this.empleadoDetalleSessionMaxAgeMs) {
        return null;
      }
      return { ...parsed.empleado };
    } catch {
      return null;
    }
  }

  private cacheEmpleadoDetalleSesion(empleadoId: number, empleado: Empleado): void {
    try {
      sessionStorage.setItem(
        `${this.empleadoDetalleSessionPrefix}${empleadoId}`,
        JSON.stringify({ at: Date.now(), empleado })
      );
    } catch {
      /* ignore quota */
    }
  }

  getEmpleados(rol?: string): Observable<any> {
    let url = `${this.apiUrl}/admin/empleados/`;
    if (rol) {
      url += `?rol=${rol}`;
    }
    return this.http.get(url, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      tap((response: any) => {
        if (response.ok) {
          this.empleadosSubject.next(response.empleados);
          // Snapshot para hidratar `/admin/empleados` instantáneo incluso con F5/URL directa.
          try {
            sessionStorage.setItem(
              this.empleadosListaSessionKey,
              JSON.stringify({ at: Date.now(), empleados: response.empleados })
            );
          } catch {
            /* ignore quota */
          }
        }
      })
    );
  }

  getEmpleado(id: number): Observable<any> {
    return this.http.get(`${this.apiUrl}/admin/empleados/${id}/`, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      tap((res: any) => {
        if (res?.ok && res.empleado) {
          this.cacheEmpleadoDetalleSesion(id, res.empleado as Empleado);
        }
      })
    );
  }

  crearEmpleado(data: any): Observable<any> {
    return this.http.post(`${this.apiUrl}/admin/empleados/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  actualizarEmpleado(id: number, data: any): Observable<any> {
    return this.http.put(`${this.apiUrl}/admin/empleados/${id}/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  eliminarEmpleado(id: number): Observable<any> {
    return this.http.delete(`${this.apiUrl}/admin/empleados/${id}/`, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  /** Barberos para agendar (endpoint público). Si se pasa servicio_id, filtra solo los que hacen ese servicio. */
  getBarberosParaAgendar(servicioId?: number): Observable<{ ok: boolean; barberos: any[] }> {
    const key = `cliente_agendar_barberos_v1_${servicioId ?? 'all'}`;
    const cached = this.readSessionCache<{ ok: boolean; barberos: any[] }>(key, 2 * 60 * 1000);
    if (cached) {
      return of(cached);
    }
    let url = `${this.apiUrl}/barberos/`;
    if (servicioId) url += `?servicio_id=${servicioId}`;
    return this.http.get(url, {
      withCredentials: true
    }).pipe(
      tap((res: any) => {
        if (res?.ok && Array.isArray(res.barberos)) {
          this.writeSessionCache(key, res as { ok: boolean; barberos: any[] });
        }
      })
    ) as Observable<{ ok: boolean; barberos: any[] }>;
  }

  /** Consultar horarios disponibles desde el backend (valida citas reales). */
  getDisponibilidad(barberoId: number, fecha: string, duracion: number): Observable<{ ok: boolean; horarios: { hora: string; disponible: boolean }[] }> {
    const key = `cliente_agendar_disponibilidad_v1_${barberoId}_${fecha}_${duracion}`;
    const cached = this.readSessionCache<{ ok: boolean; horarios: { hora: string; disponible: boolean }[] }>(key, 15 * 1000);
    if (cached) {
      return of(cached);
    }
    return this.http.get(`${this.apiUrl}/disponibilidad/?barbero_id=${barberoId}&fecha=${fecha}&duracion=${duracion}`, {
      withCredentials: true
    }).pipe(
      tap((res: any) => {
        if (res?.ok && Array.isArray(res.horarios)) {
          this.writeSessionCache(key, res as { ok: boolean; horarios: { hora: string; disponible: boolean }[] });
        }
      })
    ) as Observable<{ ok: boolean; horarios: { hora: string; disponible: boolean }[] }>;
  }

  /**
   * Crear cita en el backend (cliente o secretaría).
   * Si anticipo_pagado > 0, cuenta como ganancia el día que se agenda.
   */
  createCita(data: {
    cliente_id: number;
    barbero_id?: number;
    servicio_id: number;
    fecha: string;
    hora: string;
    duracion_minutos: number;
    precio_total: number;
    anticipo_pagado?: number;
    comprobante_pago?: string;
    codigo_descuento?: string;
    descuento_monto?: number;
    notas?: string;
  }): Observable<{ ok: boolean; id: number; fecha: string; hora: string; precio_total: number; anticipo_pagado: number; comprobante_pago?: string }> {
    return this.http.post(`${this.apiUrl}/citas/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    }) as Observable<{ ok: boolean; id: number; fecha: string; hora: string; precio_total: number; anticipo_pagado: number; comprobante_pago?: string }>;
  }

  /** Consultar política de pago para citas (incluye estado de penalización del cliente). */
  getCitaPoliticaPago(clienteId: number): Observable<{
    ok: boolean;
    requiere_anticipo: boolean;
    porcentaje_anticipo: number;
    penalizado: boolean;
    total_inasistencias: number;
    citas_restantes_penalizacion: number;
    citas_penalizacion_total: number;
    tiempo_espera_maximo: number;
    tiene_banco: boolean;
    banco_nombre: string;
    banco_cuenta: string;
    banco_titular: string;
  }> {
    const key = `cliente_cita_politica_pago_v1_${clienteId}`;
    const cached = this.readSessionCache<any>(key, 60 * 1000);
    if (cached) {
      return of(cached);
    }
    return this.http.get(`${this.apiUrl}/citas/politica-pago/?cliente_id=${clienteId}`, {
      withCredentials: true
    }).pipe(
      tap((res: any) => {
        if (res?.ok) this.writeSessionCache(key, res);
      })
    );
  }

  // ============================================
  // SILLAS (solo para barberos)
  // ============================================
  private readonly sillasListaSessionKey = 'admin_sillas_lista_v1';
  private readonly sillasListaSessionMaxAgeMs = 3 * 60 * 1000;

  getSillasCacheSnapshot(): SillaAdmin[] {
    return this.sillasSubject.value;
  }

  private persistSillasListaSesion(sillas: SillaAdmin[]): void {
    try {
      sessionStorage.setItem(this.sillasListaSessionKey, JSON.stringify({ at: Date.now(), sillas }));
    } catch {
      /* ignore */
    }
  }

  /** Última lista en memoria o sessionStorage (misma clave/TTL que `sillas-lista`). */
  getSillasListaBootstrap(): SillaAdmin[] {
    const mem = this.sillasSubject.value;
    if (mem.length > 0) {
      return mem.map((s) => ({ ...s }));
    }
    try {
      const raw = sessionStorage.getItem(this.sillasListaSessionKey);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw) as { at?: number; sillas?: SillaAdmin[] };
      if (!parsed?.sillas || typeof parsed.at !== 'number') {
        return [];
      }
      if (Date.now() - parsed.at > this.sillasListaSessionMaxAgeMs) {
        return [];
      }
      return parsed.sillas.map((s) => ({ ...s }));
    } catch {
      return [];
    }
  }

  getSillas(): Observable<any> {
    return this.http.get(`${this.apiUrl}/admin/sillas/`, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      tap((res: any) => {
        if (res?.ok && Array.isArray(res.sillas)) {
          this.sillasSubject.next(res.sillas as SillaAdmin[]);
          this.persistSillasListaSesion(res.sillas);
        }
      })
    );
  }

  crearSilla(data: { numero: string; nombre?: string }): Observable<any> {
    return this.http.post(`${this.apiUrl}/admin/sillas/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  eliminarSilla(id: number): Observable<any> {
    return this.http.delete(`${this.apiUrl}/admin/sillas/${id}/`, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  getMarcas(): Observable<any> {
    return this.http.get(`${this.apiUrl}/admin/marcas/`, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      tap((res: any) => {
        if (res?.ok && Array.isArray(res.marcas)) {
          this.marcasSubject.next(res.marcas as MarcaAdmin[]);
          this.persistMarcasListaSesion(res.marcas as MarcaAdmin[]);
        }
      })
    );
  }

  crearMarca(data: { nombre: string }): Observable<any> {
    return this.http.post(`${this.apiUrl}/admin/marcas/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  // ============================================
  // MARCAS
  // ============================================
  private readonly marcasListaSessionKey = 'admin_marcas_lista_v1';
  private readonly marcasListaSessionMaxAgeMs = 3 * 60 * 1000;

  getMarcasCacheSnapshot(): MarcaAdmin[] {
    return this.marcasSubject.value;
  }

  private persistMarcasListaSesion(marcas: MarcaAdmin[]): void {
    try {
      sessionStorage.setItem(this.marcasListaSessionKey, JSON.stringify({ at: Date.now(), marcas }));
    } catch {
      /* ignore */
    }
  }

  /** Memoria o sessionStorage (misma clave/TTL que `marcas-lista`). */
  getMarcasListaBootstrap(): MarcaAdmin[] {
    const mem = this.marcasSubject.value;
    if (mem.length > 0) {
      return mem.map((m) => ({ ...m }));
    }
    try {
      const raw = sessionStorage.getItem(this.marcasListaSessionKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { at?: number; marcas?: MarcaAdmin[] };
      if (!parsed?.marcas || typeof parsed.at !== 'number') return [];
      if (Date.now() - parsed.at > this.marcasListaSessionMaxAgeMs) return [];
      return parsed.marcas.map((m) => ({ ...m }));
    } catch {
      return [];
    }
  }

  // ============================================
  // SERVICIOS
  // ============================================
  private readonly serviciosListaSessionKey = 'admin_servicios_lista_v1';
  private readonly serviciosListaSessionMaxAgeMs = 3 * 60 * 1000;
  private serviciosInFlight = false;

  getServiciosCacheSnapshot(): Servicio[] {
    return this.serviciosSubject.value;
  }

  private persistServiciosListaSesion(servicios: Servicio[]): void {
    try {
      sessionStorage.setItem(this.serviciosListaSessionKey, JSON.stringify({ at: Date.now(), servicios }));
    } catch {
      /* ignore */
    }
  }

  /** Memoria o sessionStorage (misma clave/TTL que `servicios-lista`). */
  getServiciosListaBootstrap(): Servicio[] {
    const mem = this.serviciosSubject.value;
    if (mem.length > 0) {
      return mem.map((s) => ({ ...s }));
    }
    try {
      const raw = sessionStorage.getItem(this.serviciosListaSessionKey);
      if (!raw) {
        return [];
      }
      const parsed = JSON.parse(raw) as { at?: number; servicios?: Servicio[] };
      if (!parsed?.servicios || typeof parsed.at !== 'number') {
        return [];
      }
      if (Date.now() - parsed.at > this.serviciosListaSessionMaxAgeMs) {
        return [];
      }
      return parsed.servicios.map((s) => ({ ...s }));
    } catch {
      return [];
    }
  }

  getServicios(): Observable<any> {
    const cached = this.readSessionCache<{ ok: boolean; servicios: Servicio[] }>(
      this.serviciosListaSessionKey,
      this.serviciosListaSessionMaxAgeMs
    );
    if (cached?.ok && Array.isArray(cached.servicios)) {
      // Hidrata memoria para componentes que usan snapshot.
      if (this.serviciosSubject.value.length === 0) {
        this.serviciosSubject.next(cached.servicios);
      }
      return of(cached);
    }

    if (this.serviciosInFlight) {
      // Evita duplicar requests; usa lo que haya en memoria.
      const mem = this.serviciosSubject.value;
      if (mem.length > 0) return of({ ok: true, servicios: mem });
    }

    this.serviciosInFlight = true;
    return this.http.get(`${this.apiUrl}/admin/servicios/`, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      tap((response: any) => {
        if (response?.ok && Array.isArray(response.servicios)) {
          this.serviciosSubject.next(response.servicios as Servicio[]);
          // Guardar con el mismo formato {at,value} de `writeSessionCache`.
          this.writeSessionCache(this.serviciosListaSessionKey, response as { ok: boolean; servicios: Servicio[] });
        }
      }),
      tap(() => {
        this.serviciosInFlight = false;
      })
    );
  }

  private readonly servicioDetalleEdicionPrefix = 'admin_servicio_detalle_v1_';
  private readonly servicioDetalleEdicionMaxAgeMs = 5 * 60 * 1000;

  private cacheServicioDetalleEdicionSesion(servicioId: number, servicio: unknown): void {
    try {
      sessionStorage.setItem(
        `${this.servicioDetalleEdicionPrefix}${servicioId}`,
        JSON.stringify({ at: Date.now(), servicio })
      );
    } catch {
      /* ignore */
    }
  }

  /**
   * Detalle reciente (sessionStorage) o fila mínima desde lista en memoria/sesión (sin galería/barberos hasta el GET).
   */
  getServicioEdicionBootstrap(servicioId: number): Record<string, unknown> | null {
    try {
      const raw = sessionStorage.getItem(`${this.servicioDetalleEdicionPrefix}${servicioId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { at?: number; servicio?: Record<string, unknown> };
        if (
          parsed?.servicio &&
          typeof parsed.at === 'number' &&
          Date.now() - parsed.at <= this.servicioDetalleEdicionMaxAgeMs
        ) {
          return { ...parsed.servicio };
        }
      }
    } catch {
      /* ignore */
    }
    const fromLista =
      this.getServiciosCacheSnapshot().find((s) => s.id === servicioId) ??
      this.getServiciosListaBootstrap().find((s) => s.id === servicioId);
    if (!fromLista) {
      return null;
    }
    return {
      id: fromLista.id,
      nombre: fromLista.nombre,
      descripcion: fromLista.descripcion,
      precio: fromLista.precio,
      duracion_minutos: fromLista.duracion_minutos,
      categoria: fromLista.categoria,
      activo: fromLista.activo,
      popular: fromLista.popular,
      imagen_url: fromLista.imagen_url,
      imagenes_galeria: [] as string[],
      barberos_ids: [] as number[],
      etiquetas: [] as string[],
    };
  }

  getServicio(id: number): Observable<any> {
    return this.http.get(`${this.apiUrl}/admin/servicios/${id}/`, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      tap((res: any) => {
        if (res?.ok && res.servicio) {
          this.cacheServicioDetalleEdicionSesion(id, res.servicio);
        }
      })
    );
  }

  crearServicio(data: any): Observable<any> {
    return this.http.post(`${this.apiUrl}/admin/servicios/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  actualizarServicio(id: number, data: any): Observable<any> {
    return this.http.put(`${this.apiUrl}/admin/servicios/${id}/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  eliminarServicio(id: number): Observable<any> {
    return this.http.delete(`${this.apiUrl}/admin/servicios/${id}/`, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  // ============================================
  // PRODUCTOS
  // ============================================
  private readonly productosCatalogSessionKey = 'admin_productos_catalog_v2';
  private readonly productosCatalogSessionMaxAgeMs = 3 * 60 * 1000;
  private readonly productoDetalleEdicionPrefix = 'admin_producto_detalle_v1_';
  private readonly productoDetalleEdicionMaxAgeMs = 5 * 60 * 1000;

  getProductosCacheSnapshot(): Producto[] {
    return this.productosSubject.value;
  }

  // Snapshot para inventario (lista completa de activos, `?activo=1`)
  private readonly productosActivosSessionKey = 'admin_productos_activos_v1';
  private readonly productosActivosSessionMaxAgeMs = 3 * 60 * 1000;

  /** Memoria o sessionStorage (solo activos) para inventario / reportes. */
  getProductosActivosBootstrap(): Producto[] {
    const mem = this.productosSubject.value;
    if (mem.length > 0) {
      return mem.filter((p) => p?.activo !== false).map((p) => ({ ...p }));
    }
    try {
      const cached = this.readSessionCache<{ ok: boolean; productos: Producto[] }>(
        this.productosActivosSessionKey,
        this.productosActivosSessionMaxAgeMs
      );
      if (!cached?.ok || !Array.isArray(cached.productos)) return [];
      return cached.productos.map((p) => ({ ...p }));
    } catch {
      return [];
    }
  }

  private persistProductosCatalogSesion(response: any, query: ProductosCatalogQuery): void {
    try {
      sessionStorage.setItem(
        this.productosCatalogSessionKey,
        JSON.stringify({
          at: Date.now(),
          query,
          productos: response.productos,
          total: response.total,
          total_pages: response.total_pages,
          stats: response.stats,
          marcas_filtro: response.marcas_filtro ?? [],
        })
      );
    } catch {
      /* ignore quota */
    }
  }

  /** Última página de catálogo (filtros + totales) para pintar al instante al volver a la lista. */
  getProductosCatalogBootstrap(): ProductosCatalogBootstrap | null {
    try {
      const raw = sessionStorage.getItem(this.productosCatalogSessionKey);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as {
        at?: number;
        query?: ProductosCatalogQuery;
        productos?: Producto[];
        total?: number;
        total_pages?: number;
        stats?: ProductosCatalogBootstrap['stats'];
        marcas_filtro?: string[];
      };
      if (
        !parsed?.productos ||
        !Array.isArray(parsed.productos) ||
        typeof parsed.at !== 'number' ||
        !parsed.query
      ) {
        return null;
      }
      if (Date.now() - parsed.at > this.productosCatalogSessionMaxAgeMs) {
        return null;
      }
      return {
        query: { ...parsed.query },
        productos: parsed.productos.map((p) => ({ ...p })),
        total: typeof parsed.total === 'number' ? parsed.total : 0,
        total_pages: typeof parsed.total_pages === 'number' ? parsed.total_pages : 1,
        stats: {
          total_filtrado: parsed.stats?.total_filtrado,
          disponibles: parsed.stats?.disponibles ?? 0,
          stock_bajo: parsed.stats?.stock_bajo ?? 0,
          agotados: parsed.stats?.agotados ?? 0,
        },
        marcas_filtro: Array.isArray(parsed.marcas_filtro) ? [...parsed.marcas_filtro] : [],
      };
    } catch {
      return null;
    }
  }

  /** Filas de la última página guardada (p. ej. bootstrap de edición). */
  getProductosListaBootstrap(): Producto[] {
    const b = this.getProductosCatalogBootstrap();
    return b?.productos?.length ? b.productos.map((p) => ({ ...p })) : [];
  }

  private cacheProductoDetalleEdicionSesion(productoId: number, producto: unknown): void {
    try {
      sessionStorage.setItem(
        `${this.productoDetalleEdicionPrefix}${productoId}`,
        JSON.stringify({ at: Date.now(), producto })
      );
    } catch {
      /* ignore */
    }
  }

  /** Detalle reciente o fila del catálogo (sin galería completa hasta el GET). */
  getProductoEdicionBootstrap(productoId: number): Record<string, unknown> | null {
    try {
      const raw = sessionStorage.getItem(`${this.productoDetalleEdicionPrefix}${productoId}`);
      if (raw) {
        const parsed = JSON.parse(raw) as { at?: number; producto?: Record<string, unknown> };
        if (
          parsed?.producto &&
          typeof parsed.at === 'number' &&
          Date.now() - parsed.at <= this.productoDetalleEdicionMaxAgeMs
        ) {
          return { ...parsed.producto };
        }
      }
    } catch {
      /* ignore */
    }
    const fromLista =
      this.getProductosCacheSnapshot().find((p) => p.id === productoId) ??
      this.getProductosListaBootstrap().find((p) => p.id === productoId);
    if (!fromLista) {
      return null;
    }
    return {
      id: fromLista.id,
      nombre: fromLista.nombre,
      marca: fromLista.marca,
      descripcion: fromLista.descripcion,
      peso_volumen: fromLista.peso_volumen,
      categoria: fromLista.categoria,
      precio: fromLista.precio,
      stock: fromLista.stock,
      stock_minimo: fromLista.stock_minimo,
      imagen_url: fromLista.imagen_url,
      activo: fromLista.activo,
      destacado: fromLista.destacado,
      imagenes_galeria: [] as string[],
    };
  }

  /**
   * `soloActivos=true`: lista completa de activos (`?activo=1`, inventario).
   * Sin `activo`: catálogo admin paginado; pasar `catalog` con filtros y página.
   */
  getProductos(soloActivos = false, catalog?: Partial<ProductosCatalogQuery>): Observable<any> {
    if (soloActivos) {
      const cached = this.readSessionCache<{ ok: boolean; productos: Producto[] }>(
        this.productosActivosSessionKey,
        this.productosActivosSessionMaxAgeMs
      );
      if (cached?.ok && Array.isArray(cached.productos)) {
        if (this.productosSubject.value.length === 0) {
          this.productosSubject.next(cached.productos);
        }
        return of(cached);
      }
      const url = `${this.apiUrl}/admin/productos/?activo=1`;
      return this.http.get(url, {
        headers: this.getHeaders(),
        withCredentials: true,
      }).pipe(
        tap((response: any) => {
          if (response.ok && Array.isArray(response.productos)) {
            this.productosSubject.next(response.productos);
            this.writeSessionCache(this.productosActivosSessionKey, response as { ok: boolean; productos: Producto[] });
          }
        })
      );
    }

    const q = this.buildProductosCatalogQuery(catalog);

    const params = this.buildProductosCatalogParams(q);

    return this.http
      .get(`${this.apiUrl}/admin/productos/`, {
        params,
        headers: this.getHeaders(),
        withCredentials: true,
      })
      .pipe(
        tap((response: any) => {
          if (response.ok && Array.isArray(response.productos)) {
            this.productosSubject.next(response.productos);
            this.persistProductosCatalogSesion(response, q);
          }
        })
      );
  }

  private buildProductosCatalogQuery(catalog?: Partial<ProductosCatalogQuery>): ProductosCatalogQuery {
    return {
      page: catalog?.page ?? 1,
      perPage: catalog?.perPage ?? 8,
      q: catalog?.q ?? '',
      categoria: catalog?.categoria ?? '',
      marca: catalog?.marca ?? '',
      estado: catalog?.estado ?? 'activo',
    };
  }

  private buildProductosCatalogParams(q: ProductosCatalogQuery): HttpParams {
    let params = new HttpParams().set('page', String(q.page)).set('per_page', String(q.perPage));
    const qq = (q.q || '').trim();
    if (qq) params = params.set('q', qq);
    const cat = (q.categoria || '').trim();
    if (cat) params = params.set('categoria', cat);
    const mar = (q.marca || '').trim();
    if (mar) params = params.set('marca', mar);
    const est = (q.estado || 'activo').trim().toLowerCase();
    if (est && est !== 'activo') params = params.set('estado', est);
    return params;
  }

  getProducto(id: number): Observable<any> {
    return this.http.get(`${this.apiUrl}/admin/productos/${id}/`, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      tap((res: any) => {
        if (res?.ok && res.producto) {
          this.cacheProductoDetalleEdicionSesion(id, res.producto);
        }
      })
    );
  }

  crearProducto(data: any): Observable<any> {
    return this.http.post(`${this.apiUrl}/admin/productos/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  actualizarProducto(id: number, data: any): Observable<any> {
    return this.http.put(`${this.apiUrl}/admin/productos/${id}/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  eliminarProducto(id: number): Observable<any> {
    return this.http.delete(`${this.apiUrl}/admin/productos/${id}/`, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  // ============================================
  // PROMOCIONES
  // ============================================
  getPromociones(estado: 'activas' | 'programadas' | 'finalizadas' | 'pausadas' | 'todas' = 'todas'): Observable<any> {
    return this.http.get(`${this.apiUrl}/admin/promociones/?estado=${encodeURIComponent(estado)}`, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  getPromocion(id: number): Observable<any> {
    return this.http.get(`${this.apiUrl}/admin/promociones/${id}/`, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  crearPromocion(data: Partial<PromocionAdmin>): Observable<any> {
    return this.http.post(`${this.apiUrl}/admin/promociones/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  actualizarPromocion(id: number, data: Partial<PromocionAdmin>): Observable<any> {
    return this.http.put(`${this.apiUrl}/admin/promociones/${id}/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  eliminarPromocion(id: number): Observable<any> {
    return this.http.delete(`${this.apiUrl}/admin/promociones/${id}/`, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  actualizarStock(id: number, cantidad: number, operacion: 'sumar' | 'establecer' = 'sumar', notas?: string): Observable<any> {
    const body: { cantidad: number; operacion: string; notas?: string } = { cantidad, operacion };
    if (notas !== undefined) body.notas = notas;
    return this.http.put(`${this.apiUrl}/admin/productos/${id}/stock/`, body, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  /** Historial de movimientos de inventario (entradas/salidas). hoy=true solo movimientos del día. */
  getMovimientosInventario(limit = 100, hoy = false): Observable<{ ok: boolean; movimientos?: Array<{ id: number; producto: string; producto_id: number; tipo: string; cantidad: number; usuario: string; fecha: string; notas: string }> }> {
    let url = `${this.apiUrl}/admin/inventario/movimientos/?limit=${limit}`;
    if (hoy) url += '&hoy=1';
    return this.http.get<{ ok: boolean; movimientos?: Array<{ id: number; producto: string; producto_id: number; tipo: string; cantidad: number; usuario: string; fecha: string; notas: string }> }>(url, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  /**
   * Registrar salidas de inventario en lote (venta cliente o venta en tienda).
   * Reduce stock y crea movimientos tipo 'salida' para cada ítem.
   * items: [{ producto_id, cantidad }, ...]
   * origen: 'venta_cliente' | 'venta_tienda'
   * referencia: opcional (ej. "Pedido #123")
   */
  registrarSalidasInventario(
    items: Array<{ producto_id: number; cantidad: number }>,
    origen: 'venta_cliente' | 'venta_tienda' = 'venta_tienda',
    referencia?: string
  ): Observable<{ ok: boolean; mensaje?: string; items_procesados?: number }> {
    const body: { items: typeof items; origen: string; referencia?: string } = { items, origen };
    if (referencia !== undefined) body.referencia = referencia;
    return this.http.post<{ ok: boolean; mensaje?: string; items_procesados?: number }>(
      `${this.apiUrl}/admin/inventario/salidas-masivas/`,
      body,
      { headers: this.getHeaders(), withCredentials: true }
    );
  }

  // ============================================
  // CONFIGURACIÓN
  // ============================================
  getConfiguracion(): Observable<any> {
    const cacheKey = 'admin_configuracion_v1';
    const cached = this.readSessionCache<any>(cacheKey, 60 * 1000);
    if (cached) {
      return of(cached);
    }
    return this.http.get(`${this.apiUrl}/admin/configuracion/`, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      tap((res: any) => {
        // Compatibilidad: backend puede devolver {configuracion} o directo.
        if (res) this.writeSessionCache(cacheKey, res);
      })
    );
  }

  /** Configuración pública (contacto + horarios) para Contáctanos, sin auth. */
  getConfiguracionPublica(force = false): Observable<ConfiguracionPublicaResponse> {
    const headers = new HttpHeaders({ 'Content-Type': 'application/json' });

    if (!force) {
      const snap = this.configuracionPublicaSubject.value;
      if (snap?.ok) {
        return of(snap);
      }
      const cached = this.readConfiguracionPublicaCache();
      if (cached?.ok) {
        this.configuracionPublicaSubject.next(cached);
        return of(cached);
      }
    }

    return this.http.get(`${this.apiUrl}/public/contacto/`, {
      headers,
      withCredentials: true
    }).pipe(
      catchError(() => {
        // Compatibilidad con backend que expone /configuracion-publica/ en lugar de /public/contacto/.
        return this.http.get(`${this.apiUrl}/configuracion-publica/`, {
          headers,
          withCredentials: true
        });
      }),
      map((res: any) => {
        const c = res?.configuracion ?? res ?? {};
        let horariosPorDia: any[] = [];
        if (Array.isArray(c.horarios_por_dia)) {
          horariosPorDia = c.horarios_por_dia;
        } else if (Array.isArray(c.horarios)) {
          horariosPorDia = c.horarios.map((h: any) => ({
            dia_semana: h?.dia_semana,
            abierto: !!h?.abierto,
            apertura: h?.apertura ?? h?.hora_apertura ?? null,
            cierre: h?.cierre ?? h?.hora_cierre ?? null,
          }));
        }

        const normalizado = {
          ...c,
          telefono: c.telefono ?? '',
          email_contacto: c.email_contacto ?? c.correo ?? '',
          direccion: c.direccion ?? c.direccion_texto ?? '',
          logo_texto: c.logo_texto ?? c.logo_texto_parte1 ?? 'Stylo',
          logo_texto_acento: c.logo_texto_acento ?? c.logo_texto_parte2 ?? 'Barber',
          horarios_por_dia: horariosPorDia,
        };

        // Compatibilidad: mantener formato esperado por componentes antiguos y nuevos.
        return {
          ...normalizado,
          ok: true,
          configuracion: normalizado,
        };
      }),
      tap((normalizado) => {
        this.configuracionPublicaSubject.next(normalizado);
        this.writeConfiguracionPublicaCache(normalizado);
      })
    );
  }

  /** Fuerza recarga de configuración pública y notifica a los componentes suscritos. */
  refrescarConfiguracionPublica(): void {
    if (this.configuracionPublicaInFlight) return;
    this.configuracionPublicaInFlight = true;
    this.getConfiguracionPublica(true).subscribe({
      // El cache reactivo se actualiza en el tap de getConfiguracionPublica().
      next: () => { this.configuracionPublicaInFlight = false; },
      error: () => { this.configuracionPublicaInFlight = false; }
    });
  }

  actualizarConfiguracion(data: Partial<Configuracion> & { horarios_por_dia?: HorarioDiaConfig[]; codigo_2fa?: string; temp_token_clip?: string }): Observable<any> {
    return this.http.put(`${this.apiUrl}/admin/configuracion/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  /**
   * Solicita envío de código 2FA por correo para poder actualizar credenciales Clip.
   * Solo administradores. El código debe enviarse luego en actualizarConfiguracion como codigo_2fa junto con temp_token_clip.
   */
  solicitarClip2FA(): Observable<{ ok: boolean; tempToken: string; mensaje?: string; codigo_debug?: string }> {
    return this.http.post<{ ok: boolean; tempToken: string; mensaje?: string; codigo_debug?: string }>(
      `${this.apiUrl}/admin/configuracion/clip/solicitar-2fa/`,
      {},
      { headers: this.getHeaders(), withCredentials: true }
    );
  }

  /**
   * Sube el logo de configuración al endpoint dedicado del backend.
   * El backend espera el archivo en el campo "logo".
   */
  uploadLogoConfiguracion(file: File): Observable<any> {
    const formData = new FormData();
    formData.append('logo', file);

    return this.http.post(`${this.apiUrl}/admin/configuracion/upload-logo/`, formData, {
      withCredentials: true
    });
  }

  // ============================================
  // REPORTES
  // ============================================
  /** Sin params: resumen. Con tipo: detalle. desde/hasta en YYYY-MM-DD para filtrar por rango. */
  getReportes(tipo?: string, periodo?: string, desde?: string, hasta?: string): Observable<any> {
    let url = `${this.apiUrl}/admin/reportes/`;
    const params: string[] = [];
    if (tipo) params.push(`tipo=${encodeURIComponent(tipo)}`);
    if (periodo) params.push(`periodo=${encodeURIComponent(periodo)}`);
    if (desde) params.push(`desde=${encodeURIComponent(desde)}`);
    if (hasta) params.push(`hasta=${encodeURIComponent(hasta)}`);
    if (params.length) url += '?' + params.join('&');
    return this.http.get(url, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  getPrediccionVentas(params?: {
    categoria?: string;
    subcategoria_id?: number | null;
    producto_id?: number | null;
    desde?: string;
    hasta?: string;
    pred_scope?: 'dia' | 'mes';
    modo?: 'prueba';
  }): Observable<PrediccionVentasResponse> {
    const cacheKey = this.prediccionVentasCacheKey(params);
    const cached = this.readPrediccionVentasCache(cacheKey);
    if (cached) {
      // Stale-while-revalidate: devolvemos cache instantáneo y la UI puede refrescar aparte si quiere.
      return of(cached);
    }

    const q: string[] = [];
    if (params?.categoria) q.push(`categoria=${encodeURIComponent(params.categoria)}`);
    if (params?.subcategoria_id) q.push(`subcategoria_id=${encodeURIComponent(String(params.subcategoria_id))}`);
    if (params?.producto_id) q.push(`producto_id=${encodeURIComponent(String(params.producto_id))}`);
    if (params?.desde) q.push(`desde=${encodeURIComponent(params.desde)}`);
    if (params?.hasta) q.push(`hasta=${encodeURIComponent(params.hasta)}`);
    if (params?.pred_scope) q.push(`pred_scope=${encodeURIComponent(params.pred_scope)}`);
    if (params?.modo) q.push(`modo=${encodeURIComponent(params.modo)}`);
    const suffix = q.length ? `?${q.join('&')}` : '';
    return this.http.get<PrediccionVentasResponse>(`${this.apiUrl}/admin/prediccion-ventas/${suffix}`, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      tap((res) => {
        if (res?.ok) {
          this.writePrediccionVentasCache(cacheKey, res);
        }
      })
    );
  }

  private readonly prediccionVentasSessionPrefix = 'admin_prediccion_ventas_v1_';
  private readonly prediccionVentasSessionMaxAgeMs = 2 * 60 * 1000;

  private prediccionVentasCacheKey(params?: {
    categoria?: string;
    subcategoria_id?: number | null;
    producto_id?: number | null;
    desde?: string;
    hasta?: string;
    pred_scope?: 'dia' | 'mes';
    modo?: 'prueba';
  }): string {
    const c = (params?.categoria || '').trim().toLowerCase();
    const s = params?.subcategoria_id ?? '';
    const p = params?.producto_id ?? '';
    const d = (params?.desde || '').trim();
    const h = (params?.hasta || '').trim();
    const ps = params?.pred_scope ?? '';
    const m = params?.modo ?? '';
    return `${this.prediccionVentasSessionPrefix}${c}|${s}|${p}|${d}|${h}|${ps}|${m}`;
  }

  private readPrediccionVentasCache(key: string): PrediccionVentasResponse | null {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { at?: number; value?: PrediccionVentasResponse };
      if (!parsed?.value || typeof parsed.at !== 'number') return null;
      if (Date.now() - parsed.at > this.prediccionVentasSessionMaxAgeMs) return null;
      return parsed.value;
    } catch {
      return null;
    }
  }

  private writePrediccionVentasCache(key: string, value: PrediccionVentasResponse): void {
    this.writeSessionCache(key, value);
  }

  getMonitoreoBD(): Observable<MonitoreoBDResponse> {
    const cacheKey = 'admin_monitoreo_bd_snapshot_v1';
    const cached = this.readMonitoreoBdCache(cacheKey);
    if (cached) {
      return of(cached);
    }

    return this.http.get<MonitoreoBDResponse>(`${this.apiUrl}/admin/monitoreo-bd/`, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      tap((res) => {
        if (res?.ok) {
          this.writeMonitoreoBdCache(cacheKey, res);
        }
      })
    );
  }

  private readonly monitoreoBdSessionMaxAgeMs = 20 * 1000;

  private readMonitoreoBdCache(key: string): MonitoreoBDResponse | null {
    return this.readSessionCache<MonitoreoBDResponse>(key, this.monitoreoBdSessionMaxAgeMs);
  }

  private writeMonitoreoBdCache(key: string, value: MonitoreoBDResponse): void {
    this.writeSessionCache(key, value);
  }

  // ============================================
  // RESPALDOS DE BASE DE DATOS
  // ============================================
  getRespaldoBDStatus(forceRefresh = false): Observable<RespaldoBDStatus> {
    const cacheKey = 'admin_respaldo_bd_status_v1';
    if (forceRefresh) {
      try {
        sessionStorage.removeItem(cacheKey);
      } catch {
        /* ignore */
      }
    } else {
      const cached = this.readRespaldoStatusCache(cacheKey);
      if (cached) {
        return of(cached);
      }
    }

    const fetchOnce = () =>
      this.http.get<RespaldoBDStatus>(`${this.apiUrl}/admin/respaldo-db/?action=status`, {
        headers: this.getHeaders(),
        withCredentials: true
      });

    const attempt = (n: number): Observable<RespaldoBDStatus> =>
      fetchOnce().pipe(
        tap((res) => {
          if (res?.ok) this.writeRespaldoStatusCache(cacheKey, res);
        }),
        catchError((err: unknown) => {
          const status = typeof (err as { status?: number })?.status === 'number' ? (err as { status: number }).status : 0;
          const retriable = status === 0 || status === 502 || status === 503 || status === 504;
          if (forceRefresh && retriable && n < 6) {
            return timer(1200 + n * 1800).pipe(switchMap(() => attempt(n + 1)));
          }
          return throwError(() => err);
        })
      );

    return attempt(0);
  }

  getRespaldoTablas(schema?: string): Observable<{ ok: boolean; tables: RespaldoTablaItem[] }> {
    let url = `${this.apiUrl}/admin/respaldo-db/?action=tables`;
    if (schema) {
      url += `&schema=${encodeURIComponent(schema)}`;
    }
    const cacheKey = `admin_respaldo_bd_tablas_v1_${schema || 'all'}`;
    const cached = this.readRespaldoTablasCache(cacheKey);
    if (cached) {
      return of(cached);
    }
    return this.http.get<{ ok: boolean; tables: RespaldoTablaItem[] }>(url, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      tap((res) => {
        if (res?.ok && Array.isArray((res as any).tables)) this.writeRespaldoTablasCache(cacheKey, res);
      })
    );
  }

  private readonly respaldoBdSessionMaxAgeMs = 30 * 1000;

  private readRespaldoStatusCache(key: string): RespaldoBDStatus | null {
    return this.readSessionCache<RespaldoBDStatus>(key, this.respaldoBdSessionMaxAgeMs);
  }

  private writeRespaldoStatusCache(key: string, value: RespaldoBDStatus): void {
    this.writeSessionCache(key, value);
  }

  private readRespaldoTablasCache(
    key: string
  ): { ok: boolean; tables: RespaldoTablaItem[] } | null {
    return this.readSessionCache<{ ok: boolean; tables: RespaldoTablaItem[] }>(
      key,
      this.respaldoBdSessionMaxAgeMs
    );
  }

  private writeRespaldoTablasCache(key: string, value: { ok: boolean; tables: RespaldoTablaItem[] }): void {
    this.writeSessionCache(key, value);
  }

  private readSessionCache<T>(key: string, maxAgeMs: number): T | null {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { at?: number; value?: T };
      if (!parsed?.value || typeof parsed.at !== 'number') return null;
      if (Date.now() - parsed.at > maxAgeMs) return null;
      return parsed.value;
    } catch {
      return null;
    }
  }

  private writeSessionCache<T>(key: string, value: T): void {
    try {
      sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), value }));
    } catch {
      /* ignore */
    }
  }

  crearRespaldoBD(tablasSeleccionadas?: Array<{ schema: string; table: string }>, schema?: string): Observable<any> {
    // Respaldo completo: descarga inmediata como ZIP (no se guarda en servidor).
    const body: any = { action: 'create_backup_full' };
    return this.http.post(`${this.apiUrl}/admin/respaldo-db/`, body, {
      headers: this.getHeaders(),
      withCredentials: true,
      responseType: 'blob',
      observe: 'response'
    });
  }

  crearRespaldoLogicoBD(kind: 'citas' | 'compras' | 'inventario' | 'servicios'): Observable<any> {
    const body: any = { action: 'create_backup_logical', kind };
    return this.http.post(`${this.apiUrl}/admin/respaldo-db/`, body, {
      headers: this.getHeaders(),
      withCredentials: true,
      responseType: 'blob',
      observe: 'response'
    });
  }

  descargarRespaldoBD(archivo: string): Observable<any> {
    return this.http.get(`${this.apiUrl}/admin/respaldo-db/descargar/${encodeURIComponent(archivo)}/`, {
      withCredentials: true,
      responseType: 'blob',
      observe: 'response'
    });
  }

  exportarTablaCSV(schema: string, table: string): Observable<{ ok: boolean; filename: string; content_base64: string; row_count?: number; column_count?: number }> {
    return this.http.post<{ ok: boolean; filename: string; content_base64: string; row_count?: number; column_count?: number }>(
      `${this.apiUrl}/admin/respaldo-db/`,
      { action: 'export_csv', schema, table },
      {
        headers: this.getHeaders(),
        withCredentials: true
      }
    );
  }

  // ============================================
  // IMÁGENES - CLOUDINARY
  // ============================================
  
  /**
   * Subir imagen a Cloudinary
   * @param file Archivo de imagen o string base64
   * @param folder Carpeta en Cloudinary (ej: 'servicios', 'productos')
   */
  uploadImage(file: File | string, folder: string = 'barberia'): Observable<any> {
    if (typeof file === 'string') {
      // Es base64
      return this.http.post(`${this.apiUrl}/admin/upload/`, 
        { image: file, folder },
        {
          headers: this.getHeaders(),
          withCredentials: true
        }
      );
    } else {
      // Es archivo
      const formData = new FormData();
      formData.append('image', file);
      formData.append('folder', folder);
      
      // No usar Content-Type header para FormData
      return this.http.post(`${this.apiUrl}/admin/upload/`, formData, {
        withCredentials: true
      });
    }
  }

  /**
   * Eliminar imagen de Cloudinary
   * @param publicId ID público de la imagen en Cloudinary
   */
  deleteImage(publicId: string): Observable<any> {
    return this.http.post(`${this.apiUrl}/admin/delete-image/`, 
      { public_id: publicId },
      {
        headers: this.getHeaders(),
        withCredentials: true
      }
    );
  }

  // ============================================
  // CONTENIDO LEGAL / INSTITUCIONAL
  // ============================================
  getContenidoLegal(): Observable<any> {
    const cacheKey = 'admin_contenido_legal_v1';
    const cached = this.readSessionCache<any>(cacheKey, 60 * 1000);
    if (cached) {
      return of(cached);
    }

    return this.http.get(`${this.apiUrl}/admin/contenido-legal/`, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      tap((res: any) => {
        if (res?.ok) this.writeSessionCache(cacheKey, res);
      })
    );
  }

  crearContenidoLegal(data: { tipo: string; titulo: string; contenido: string; activo?: boolean }): Observable<any> {
    return this.http.post(`${this.apiUrl}/admin/contenido-legal/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  actualizarContenidoLegal(id: number, data: Partial<{ titulo: string; contenido: string; activo: boolean }>): Observable<any> {
    return this.http.put(`${this.apiUrl}/admin/contenido-legal/${id}/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  eliminarContenidoLegal(id: number): Observable<any> {
    return this.http.delete(`${this.apiUrl}/admin/contenido-legal/${id}/`, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  /** Público: contenidos activos (sin auth). */
  getContenidoLegalPublico(tipo?: string): Observable<any> {
    let url = `${this.apiUrl}/contenido-legal/`;
    if (tipo) url += `?tipo=${encodeURIComponent(tipo)}`;
    return this.http.get(url, {
      headers: new HttpHeaders({ 'Content-Type': 'application/json' }),
      withCredentials: true
    });
  }

  // ============================================
  // HELPERS
  // ============================================
  getProductosStockBajo(): Producto[] {
    return this.productosSubject.value.filter(p => p.stock <= p.stock_minimo && p.activo);
  }

  getEmpleadosActivos(): Empleado[] {
    return this.empleadosSubject.value.filter(e => e.activo);
  }

  getServiciosActivos(): Servicio[] {
    return this.serviciosSubject.value.filter(s => s.activo);
  }
}
