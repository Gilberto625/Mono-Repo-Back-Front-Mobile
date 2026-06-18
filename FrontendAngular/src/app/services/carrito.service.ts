import { Injectable, signal, computed, effect } from '@angular/core';
import { ItemCarrito, Carrito, Producto, MetodoEntrega } from '../models';

const STORAGE_KEY = 'stylo_carrito';

@Injectable({
  providedIn: 'root'
})
export class CarritoService {

  private itemsCarrito = signal<ItemCarrito[]>([]);
  private promocionAplicada = signal<null | {
    codigo: string;
    tipo_descuento: 'porcentaje' | 'monto_fijo' | '2x1' | 'producto_gratis';
    valor_descuento: number;
  }>(null);
  private metodoEntrega = signal<MetodoEntrega>('recoger_local');

  // Costos de envío
  private costosEnvio: Record<MetodoEntrega, number> = {
    'recoger_local': 0,
    'moto_mandado': 45,
    'paqueteria': 150
  };

  items = computed(() => this.itemsCarrito());

  cantidadItems = computed(() =>
    this.itemsCarrito().reduce((total, item) => total + item.cantidad, 0)
  );

  subtotal = computed(() =>
    this.itemsCarrito().reduce((total, item) => total + (item.precioUnitario * item.cantidad), 0)
  );

  descuento = computed(() => {
    const promo = this.promocionAplicada();
    if (!promo) return 0;

    const subtotal = this.subtotal();
    if (subtotal <= 0) return 0;

    if (promo.tipo_descuento === 'porcentaje') {
      const monto = subtotal * (Number(promo.valor_descuento || 0) / 100);
      return Number(Math.max(0, Math.min(subtotal, monto)).toFixed(2));
    }

    if (promo.tipo_descuento === 'monto_fijo') {
      return Number(Math.max(0, Math.min(subtotal, Number(promo.valor_descuento || 0))).toFixed(2));
    }

    // Para 2x1 / producto_gratis el cálculo exacto se valida en backend.
    // En carrito dejamos estimación 0 y se recalcula al confirmar pedido.
    return 0;
  });

  costoEnvio = computed(() => this.costosEnvio[this.metodoEntrega()]);

  total = computed(() => this.subtotal() - this.descuento() + this.costoEnvio());

  carrito = computed<Carrito>(() => ({
    items: this.itemsCarrito(),
    subtotal: this.subtotal(),
    descuento: this.descuento(),
    costoEnvio: this.costoEnvio(),
    total: this.total()
  }));

  constructor() {
    // Cargar desde localStorage
    this.cargarDesdeStorage();

    // Guardar en localStorage cada vez que cambie
    effect(() => {
      const items = this.itemsCarrito();
      const promocion = this.promocionAplicada();
      const metodo = this.metodoEntrega();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ items, promocionAplicada: promocion, metodoEntrega: metodo }));
    });
  }

  private cargarDesdeStorage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (Array.isArray(data.items) && data.items.length > 0) {
          const normalizados = data.items
            .filter((i: any) => i && i.productoId)
            .map((i: any) => {
              const cantidad = Number(i.cantidad || 0);
              const precioDirecto = Number(i.precioUnitario);
              const precioProducto = Number(i?.producto?.precio);
              const precioUnitario = Number.isFinite(precioDirecto) && precioDirecto > 0
                ? precioDirecto
                : (Number.isFinite(precioProducto) && precioProducto > 0 ? precioProducto : 0);
              return {
                ...i,
                cantidad: Number.isFinite(cantidad) && cantidad > 0 ? cantidad : 1,
                precioUnitario,
              };
            });
          this.itemsCarrito.set(normalizados);
        }
        // Regla de negocio: al recargar la página no se conserva el código de descuento.
        // El cliente debe volver a aplicarlo para evitar descuentos "pegados" en sesión nueva.
        this.promocionAplicada.set(null);
        if (data.metodoEntrega) {
          this.metodoEntrega.set(data.metodoEntrega);
        }
      }
    } catch {
      // Si falla el parse, empezar vacío
    }
  }

  /**
   * Agregar producto al carrito con validación de stock
   * @returns true si se agregó, false si no hay stock suficiente
   */
  agregarItem(producto: Producto, cantidad: number = 1): boolean {
    const items = this.itemsCarrito();
    const existente = items.find(i => i.productoId === producto.id);
    const cantidadActual = existente ? existente.cantidad : 0;
    const nuevaCantidad = cantidadActual + cantidad;

    // Validar stock
    if (producto.stock > 0 && nuevaCantidad > producto.stock) {
      return false;
    }

    if (existente) {
      this.itemsCarrito.update(items =>
        items.map(i =>
          i.productoId === producto.id
            ? { ...i, cantidad: nuevaCantidad, producto }
            : i
        )
      );
    } else {
      this.itemsCarrito.update(items => [...items, {
        productoId: producto.id,
        producto,
        cantidad,
        precioUnitario: producto.precio
      }]);
    }

    return true;
  }

  actualizarCantidad(productoId: string, cantidad: number): void {
    if (cantidad <= 0) {
      this.removerItem(productoId);
      return;
    }

    // Verificar stock del producto en el item
    const item = this.itemsCarrito().find(i => i.productoId === productoId);
    if (item?.producto && item.producto.stock > 0 && cantidad > item.producto.stock) {
      return; // No permitir superar stock
    }

    this.itemsCarrito.update(items =>
      items.map(i =>
        i.productoId === productoId ? { ...i, cantidad } : i
      )
    );
  }

  removerItem(productoId: string): void {
    this.itemsCarrito.update(items =>
      items.filter(i => i.productoId !== productoId)
    );
  }

  vaciarCarrito(): void {
    this.itemsCarrito.set([]);
    this.promocionAplicada.set(null);
  }

  aplicarCodigoDescuento(promo: { codigo: string; tipo_descuento: 'porcentaje' | 'monto_fijo' | '2x1' | 'producto_gratis'; valor_descuento: number }): boolean {
    const codigo = String(promo.codigo || '').trim().toUpperCase();
    if (!codigo) return false;
    this.promocionAplicada.set({
      codigo,
      tipo_descuento: promo.tipo_descuento,
      valor_descuento: Number(promo.valor_descuento || 0),
    });
    return true;
  }

  removerCodigoDescuento(): void {
    this.promocionAplicada.set(null);
  }

  getCodigoDescuento(): string | null {
    return this.promocionAplicada()?.codigo || null;
  }

  setMetodoEntrega(metodo: MetodoEntrega): void {
    this.metodoEntrega.set(metodo);
  }

  getMetodoEntrega(): MetodoEntrega {
    return this.metodoEntrega();
  }

  /** Verificar si un producto ya está en el carrito */
  estaEnCarrito(productoId: string): boolean {
    return this.itemsCarrito().some(i => i.productoId === productoId);
  }

  /** Obtener cantidad de un producto en el carrito */
  getCantidad(productoId: string): number {
    const item = this.itemsCarrito().find(i => i.productoId === productoId);
    return item ? item.cantidad : 0;
  }
}
