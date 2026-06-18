import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { Producto } from '../models';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class ProductoService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl.replace(/\/$/, '');

  private readonly cacheKey = 'stylo:productos_publicos:v2';
  private readonly cacheTtlMs = 5 * 60 * 1000;

  private readonly productosData = signal<Producto[]>([]);
  private readonly productosLoaded = signal(false);
  private productosInFlight = false;

  constructor() {
    const cached = this.readCache();
    if (cached?.length) {
      this.productosData.set(cached);
      this.productosLoaded.set(true);
    }
  }

  productos = computed(() => this.productosData().filter(p => p.activo));
  
  productosPorCategoria = computed(() => {
    const productos = this.productos();
    return {
      todos: productos,
      cabello: productos.filter(p => p.categoria === 'cabello'),
      barba: productos.filter(p => p.categoria === 'barba'),
      accesorios: productos.filter(p => p.categoria === 'accesorios'),
      kits: productos.filter(p => p.categoria === 'kit'),
      facial: productos.filter(p => p.categoria === 'facial'),
    };
  });

  productosDestacados = computed(() => 
    this.productos().filter(p => p.destacado || p.nuevo)
  );

  productosStockBajo = computed(() =>
    this.productos().filter(p => p.stock <= p.stockMinimo)
  );

  /** Cargar productos desde API (catálogo público) */
  loadProductosPublicos(): void {
    if (this.productosLoaded() && this.isCacheFresh()) {
      return;
    }

    if (this.productosInFlight) {
      return;
    }
    this.productosInFlight = true;

    this.http.get<any>(`${this.apiUrl}/public/productos/`).pipe(
      map((res: any) => {
        // Compatibilidad: algunos backends públicos responden arreglo directo y otros { ok, productos }.
        if (Array.isArray(res)) return res;
        if (res?.ok && Array.isArray(res.productos)) return res.productos;
        return [];
      }),
      map(list => list.map((p: any) => this.mapProductoFromApi(p))),
      catchError(() => of([]))
    ).subscribe({
      next: (productos) => {
        this.productosData.set(productos);
        this.productosLoaded.set(true);
        this.writeCache(productos);
        this.productosInFlight = false;
      },
      error: () => {
        this.productosLoaded.set(true);
        this.productosInFlight = false;
      }
    });
  }

  private mapProductoFromApi(p: any): Producto {
    const galeriaRaw = p?.imagenes_galeria;
    const galeria = Array.isArray(galeriaRaw)
      ? galeriaRaw.filter((url: string) => !!url?.trim?.())
      : [];
    const pesoRaw = String(p.peso_volumen ?? p.pesoVolumen ?? '').trim();
    return {
      id: String(p.id),
      nombre: p.nombre || '',
      marca: p.marca || '',
      descripcion: p.descripcion || '',
      precio: Number(p.precio) || 0,
      pesoVolumen: pesoRaw || undefined,
      categoria: p.categoria || 'cabello',
      stock: Number(p.stock ?? p.stock_actual ?? 0),
      stockMinimo: Number(p.stock_minimo ?? p.stock_minimo_alerta ?? 10),
      imagen: p.imagen_url || (galeria.length > 0 ? galeria[0] : undefined),
      imagenesGaleria: galeria,
      activo: p.activo !== false,
      destacado: !!p.destacado,
      nuevo: !!p.nuevo
    };
  }

  getProductoById(id: string): Producto | undefined {
    return this.productosData().find(p => p.id === id);
  }

  /** Obtener un producto por ID desde la API (público, para vista detalle) */
  getProductoPublicoById(id: string): Observable<Producto | null> {
    const local = this.getProductoById(String(id));
    if (local) {
      return of(local);
    }

    // El backend actual expone listado público; resolvemos el detalle desde listado.
    return this.http.get<any>(`${this.apiUrl}/public/productos/`).pipe(
      map((res: any) => {
        let list: any[] = [];
        if (Array.isArray(res)) {
          list = res;
        } else if (res?.ok && Array.isArray(res.productos)) {
          list = res.productos;
        }
        const found = list.find((p: any) => String(p?.id) === String(id));
        return found ? this.mapProductoFromApi(found) : null;
      }),
      catchError(() => of(null))
    );
  }

  private isCacheFresh(): boolean {
    try {
      const raw = sessionStorage.getItem(this.cacheKey);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const ts = Number(parsed?.ts);
      return Number.isFinite(ts) && (Date.now() - ts) < this.cacheTtlMs;
    } catch {
      return false;
    }
  }

  private readCache(): Producto[] | null {
    try {
      const raw = sessionStorage.getItem(this.cacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const items = parsed?.items;
      if (!Array.isArray(items)) return null;
      // Permitimos cache aunque esté vencido: sirve para pintar instantáneo.
      return items.map((p: any) => this.mapProductoFromApi(p));
    } catch {
      return null;
    }
  }

  private writeCache(productos: Producto[]): void {
    try {
      const items = productos.map((p) => ({
        id: p.id,
        nombre: p.nombre,
        marca: p.marca,
        descripcion: p.descripcion,
        precio: p.precio,
        peso_volumen: p.pesoVolumen,
        categoria: p.categoria,
        stock: p.stock,
        stock_minimo: p.stockMinimo,
        imagen_url: p.imagen,
        imagenes_galeria: p.imagenesGaleria,
        activo: p.activo,
        destacado: p.destacado,
        nuevo: p.nuevo,
      }));
      sessionStorage.setItem(this.cacheKey, JSON.stringify({ ts: Date.now(), items }));
    } catch {
      // ignore (quota / private mode)
    }
  }

  agregarProducto(producto: Omit<Producto, 'id'>): Producto {
    const nuevoProducto: Producto = {
      ...producto,
      id: Date.now().toString()
    };
    this.productosData.update(productos => [...productos, nuevoProducto]);
    return nuevoProducto;
  }

  actualizarProducto(id: string, datos: Partial<Producto>): void {
    this.productosData.update(productos =>
      productos.map(p => p.id === id ? { ...p, ...datos } : p)
    );
  }

  actualizarStock(id: string, cantidad: number): void {
    this.productosData.update(productos =>
      productos.map(p => p.id === id ? { ...p, stock: p.stock + cantidad } : p)
    );
  }

  eliminarProducto(id: string): void {
    this.productosData.update(productos =>
      productos.map(p => p.id === id ? { ...p, activo: false } : p)
    );
  }
}
