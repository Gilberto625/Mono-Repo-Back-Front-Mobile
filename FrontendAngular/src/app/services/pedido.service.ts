import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';
import { tap } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { API_ENDPOINTS, apiEndpoint } from '../core/api/api-endpoints';

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

export type EstadoPagoClip = 'confirmado' | 'pendiente' | 'rechazado' | 'inconsistente';

export interface ClipPagoRespuesta {
  ok: boolean;
  checkout_url?: string;
  estado_pago?: string;
  pago_directo?: boolean;
  message?: string;
  error?: string;
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

  crearPedido(data: CrearPedidoReq): Observable<any> {
    return this.http.post(apiEndpoint(this.apiUrl, API_ENDPOINTS.orders.create), data, { withCredentials: true });
  }

  validarPromocion(data: PromocionValidarReq): Observable<any> {
    return this.http.post(apiEndpoint(this.apiUrl, API_ENDPOINTS.promotions.validate), data, { withCredentials: true });
  }

  clipIntentarPago(payload: {
    tipo: 'pedido' | 'cita';
    pedido_id?: number;
    cita_id?: number;
    card_token_id?: string;
    cliente_email?: string;
    cliente_phone?: string;
  }): Observable<ClipPagoRespuesta> {
    return this.http.post<any>(apiEndpoint(this.apiUrl, API_ENDPOINTS.payments.clipIntent), payload, {
      withCredentials: true
    }).pipe(map((response) => ({
      ...response,
      checkout_url: String(response?.checkout_url || response?.payment_url || '').trim() || undefined
    })));
  }

  clipConfig(): Observable<any> {
    return this.http.post(
      apiEndpoint(this.apiUrl, API_ENDPOINTS.payments.clipIntent),
      { accion: 'config' },
      { withCredentials: true }
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
    this.http.get<{ ok: boolean; pedidos: PedidoResp[] }>(apiEndpoint(this.apiUrl, API_ENDPOINTS.orders.list), {
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

  consultarEstadoPedido(pedidoId: number): Observable<PedidoResp | null> {
    return this.http.get<{ ok: boolean; pedidos: PedidoResp[] }>(apiEndpoint(this.apiUrl, API_ENDPOINTS.orders.list), {
      withCredentials: true
    }).pipe(map((response) => response?.pedidos?.find((pedido) => pedido.id === pedidoId) || null));
  }

  normalizarEstadoPago(estado: unknown): EstadoPagoClip {
    const value = String(estado || '').trim().toLowerCase();
    if (['approved', 'paid', 'completed', 'aprobado', 'pagado', 'completado'].includes(value)) return 'confirmado';
    if (['rejected', 'failed', 'cancelled', 'rechazado', 'fallido', 'cancelado'].includes(value)) return 'rechazado';
    if (['inconsistent', 'suspicious', 'inconsistente', 'sospechoso'].includes(value)) return 'inconsistente';
    return 'pendiente';
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
