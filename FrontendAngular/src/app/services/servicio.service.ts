import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map, catchError, tap } from 'rxjs/operators';
import { Servicio } from '../models';
import { environment } from '../../environments/environment';
import { API_ENDPOINTS, apiEndpoint, publicServiceDetailPath } from '../core/api/api-endpoints';

@Injectable({
  providedIn: 'root'
})
export class ServicioService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl.replace(/\/$/, '');

  private readonly cacheKey = 'public_servicios_lista_v2';
  private readonly cacheTtlMs = 5 * 60 * 1000;
  private readonly serviciosLoaded = signal(false);
  private serviciosInFlight = false;

  // Servicios: arrancan vacíos y se hidratan desde sessionStorage o API.
  private readonly serviciosData = signal<Servicio[]>([]);

  servicios = computed(() => this.serviciosData().filter(s => s.activo));

  serviciosPorCategoria = computed(() => {
    const servicios = this.servicios();
    return {
      todos: servicios,
      cortes: servicios.filter(s => s.categoria === 'corte'),
      barba: servicios.filter(s => s.categoria === 'barba'),
      tratamientos: servicios.filter(s => s.categoria === 'tratamiento'),
      combos: servicios.filter(s => s.categoria === 'combo')
    };
  });

  getServicioById(id: string): Servicio | undefined {
    return this.serviciosData().find(s => s.id === id);
  }

  /** Cargar servicios desde API (catálogo público) */
  loadServiciosPublicos(): void {
    if (this.serviciosLoaded() && this.isCacheFresh()) return;
    if (this.serviciosInFlight) return;

    const cached = this.readCache();
    if (cached?.length) {
      this.serviciosData.set(cached);
      this.serviciosLoaded.set(true);
    }
    if (this.isCacheFresh()) return;

    this.serviciosInFlight = true;
    this.http.get<any>(apiEndpoint(this.apiUrl, API_ENDPOINTS.public.services)).pipe(
      map(res => {
        if (Array.isArray(res)) return res;
        if (res?.ok && Array.isArray(res.servicios)) return res.servicios;
        return [];
      }),
      map(list => list.map((s: any) => this.mapServicioFromApi(s))),
      tap((servicios) => {
        if (Array.isArray(servicios) && servicios.length > 0) {
          this.writeCache(servicios);
        }
      }),
      catchError(() => of(this.serviciosData())),
    ).subscribe(servicios => {
      if (Array.isArray(servicios) && servicios.length > 0) {
        this.serviciosData.set(servicios);
        this.serviciosLoaded.set(true);
      }
      this.serviciosInFlight = false;
    });
  }

  /** Obtener un servicio por ID (público, para vista detalle) */
  getServicioPublicoById(id: string): Observable<Servicio | null> {
    return this.http.get<any>(apiEndpoint(this.apiUrl, publicServiceDetailPath(id))).pipe(
      map(res => {
        if (res?.ok && res.servicio) return this.mapServicioFromApi(res.servicio);
        if (res && !res.ok && !res.servicio && !Array.isArray(res) && res.id) return this.mapServicioFromApi(res);
        return null;
      }),
      catchError(() => of(null))
    );
  }

  private mapServicioFromApi(s: any): Servicio {
    const dur = Number(s.duracion_minutos);
    const catRaw = String(s.categoria || 'corte').trim().toLowerCase();
    let categoria: Servicio['categoria'] = 'corte';
    if (catRaw === 'paquete' || catRaw === 'combo') categoria = 'combo';
    else if (catRaw === 'barba') categoria = 'barba';
    else if (catRaw === 'tratamiento') categoria = 'tratamiento';
    else if (catRaw === 'corte') categoria = 'corte';
    return {
      id: String(s.id),
      nombre: s.nombre || '',
      descripcion: s.descripcion || '',
      precio: Number(s.precio) || 0,
      duracionMinutos: Number.isFinite(dur) && dur > 0 ? dur : 30,
      imagen: s.imagen_url || (Array.isArray(s.imagenes_galeria) && s.imagenes_galeria[0]) || undefined,
      imagenesGaleria: Array.isArray(s.imagenes_galeria) ? s.imagenes_galeria : [],
      categoria,
      activo: s.activo !== false,
      popular: !!s.popular,
      etiquetas: Array.isArray(s.etiquetas) ? s.etiquetas : []
    };
  }

  agregarServicio(servicio: Omit<Servicio, 'id'>): Servicio {
    const nuevoServicio: Servicio = {
      ...servicio,
      id: Date.now().toString()
    };
    this.serviciosData.update(servicios => [...servicios, nuevoServicio]);
    return nuevoServicio;
  }

  actualizarServicio(id: string, datos: Partial<Servicio>): void {
    this.serviciosData.update(servicios =>
      servicios.map(s => s.id === id ? { ...s, ...datos } : s)
    );
  }

  eliminarServicio(id: string): void {
    this.serviciosData.update(servicios =>
      servicios.map(s => s.id === id ? { ...s, activo: false } : s)
    );
  }

  private isCacheFresh(): boolean {
    try {
      const raw = sessionStorage.getItem(this.cacheKey);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { at?: number; servicios?: Servicio[] };
      if (!parsed?.servicios || typeof parsed.at !== 'number') return false;
      return Date.now() - parsed.at <= this.cacheTtlMs;
    } catch {
      return false;
    }
  }

  private readCache(): Servicio[] | null {
    try {
      const raw = sessionStorage.getItem(this.cacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { at?: number; servicios?: Servicio[] };
      if (!parsed?.servicios || typeof parsed.at !== 'number') return null;
      return parsed.servicios;
    } catch {
      return null;
    }
  }

  private writeCache(servicios: Servicio[]): void {
    try {
      sessionStorage.setItem(this.cacheKey, JSON.stringify({ at: Date.now(), servicios }));
    } catch {
      /* ignore */
    }
  }
}
