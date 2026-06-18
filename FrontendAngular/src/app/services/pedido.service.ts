import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { environment } from '../../environments/environment';

export interface ItemPedidoReq {
  producto_id: number;
  cantidad: number;
}

export interface CrearPedidoReq {
  items: ItemPedidoReq[];
  metodo_entrega: string;
  metodo_pago: string;
  direccion_entrega?: string;
  codigo_descuento?: string;
  notas?: string;
}

export interface ItemPedidoResp {
  producto_id: number;
  producto_nombre: string;
  producto_imagen: string;
  cantidad: number;
  precio_unitario: number;
  subtotal: number;
}

export interface PedidoResp {
  id: number;
  estado: string;
  metodo_entrega: string;
  metodo_pago: string;
  direccion_entrega: string;
  subtotal: number;
  descuento: number;
  costo_envio: number;
  total: number;
  codigo_descuento: string;
  comprobante_url: string;
  notas: string;
  paqueteria_envio?: string;
  guia_envio?: string;
  ubicacion_envio?: string;
  detalle_envio?: string;
  items: ItemPedidoResp[];
  fecha_creacion: string;
}

export interface PromocionValidarReq {
  codigo: string;
  subtotal?: number;
  aplica_en_objetivo?: 'productos' | 'servicios';
  items?: Array<{ producto_id: number; cantidad: number; precio_unitario: number }>;
}

@Injectable({
  providedIn: 'root'
})
export class PedidoService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl.replace(/\/$/, '');

  private readonly pedidosCacheKey = 'cliente_pedidos_lista_v1';
  private readonly pedidosCacheTtlMs = 30 * 1000;
  private pedidosInFlight = false;

  pedidos = signal<PedidoResp[]>([]);
  cargando = signal(false);

  private getHeaders(): HttpHeaders {
    const accessToken = localStorage.getItem('accessToken') || '';
    let headers = new HttpHeaders();
    if (accessToken) {
      headers = headers.set('Authorization', `Bearer ${accessToken}`);
    }
    return headers;
  }

  crearPedido(data: CrearPedidoReq): Observable<any> {
    return this.http.post(`${this.apiUrl}/pedidos/crear/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  validarPromocion(data: PromocionValidarReq): Observable<any> {
    return this.http.post(`${this.apiUrl}/promociones/validar/`, data, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  clipIntentarPago(payload: {
    tipo: 'pedido' | 'cita';
    pedido_id?: number;
    cita_id?: number;
    modo_cobro?: 'total' | 'anticipo_monto' | 'anticipo_porcentaje';
    anticipo_monto?: number;
    anticipo_porcentaje?: number;
    penalizada?: boolean;
    card_token_id?: string;
    cliente_email?: string;
    cliente_phone?: string;
  }): Observable<any> {
    return this.http.post(`${this.apiUrl}/pagos/clip/intentar/`, payload, {
      headers: this.getHeaders(),
      withCredentials: true
    });
  }

  clipConfig(): Observable<any> {
    return this.http.post(
      `${this.apiUrl}/pagos/clip/intentar/`,
      { accion: 'config' },
      { headers: this.getHeaders(), withCredentials: true }
    );
  }

  cargarPedidos(): void {
    if (this.pedidosInFlight) return;

    const cached = this.readPedidosCache();
    if (cached?.length) {
      this.pedidos.set(cached);
    }
    if (this.isPedidosCacheFresh()) return;

    this.pedidosInFlight = true;
    this.cargando.set(this.pedidos().length === 0);
    this.http.get<{ ok: boolean; pedidos: PedidoResp[] }>(`${this.apiUrl}/pedidos/`, {
      headers: this.getHeaders(),
      withCredentials: true
    }).pipe(
      tap({
        next: (res) => {
          if (res?.ok && Array.isArray(res.pedidos)) {
            this.writePedidosCache(res.pedidos);
          }
        }
      })
    ).subscribe({
      next: (res) => {
        if (res.ok) {
          this.pedidos.set(res.pedidos);
        }
        this.cargando.set(false);
        this.pedidosInFlight = false;
      },
      error: () => {
        this.cargando.set(false);
        this.pedidosInFlight = false;
      }
    });
  }

  getPedidosCacheSnapshot(): PedidoResp[] {
    return this.pedidos().map((p) => ({ ...p, items: Array.isArray(p.items) ? p.items.map((i) => ({ ...i })) : [] }));
  }

  private isPedidosCacheFresh(): boolean {
    try {
      const raw = sessionStorage.getItem(this.pedidosCacheKey);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { at?: number; pedidos?: PedidoResp[] };
      if (!Array.isArray(parsed?.pedidos) || typeof parsed.at !== 'number') return false;
      return Date.now() - parsed.at <= this.pedidosCacheTtlMs;
    } catch {
      return false;
    }
  }

  private readPedidosCache(): PedidoResp[] | null {
    try {
      const raw = sessionStorage.getItem(this.pedidosCacheKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { at?: number; pedidos?: PedidoResp[] };
      if (!Array.isArray(parsed?.pedidos)) return null;
      return parsed.pedidos;
    } catch {
      return null;
    }
  }

  private writePedidosCache(pedidos: PedidoResp[]): void {
    try {
      sessionStorage.setItem(this.pedidosCacheKey, JSON.stringify({ at: Date.now(), pedidos }));
    } catch {
      /* ignore */
    }
  }
}
