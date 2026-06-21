import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { CarritoService } from '../../../services/carrito.service';
import { PedidoService, CrearPedidoReq } from '../../../services/pedido.service';
import { AuthService } from '../../../services/auth.service';
import { AdminService } from '../../../services/admin.service';
import { MetodoEntrega } from '../../../models';
import { firstValueFrom } from 'rxjs';

type MetodoPago = 'efectivo' | 'tarjeta' | 'transferencia';

interface ConfigPagos {
  pago_efectivo_activo: boolean;
  pago_tarjeta_activo: boolean;
  pago_transferencia_activo: boolean;
  clip_habilitado: boolean;
  clip_url: string;
  clip_api_key_public: string;
  banco_nombre: string;
  banco_cuenta: string;
  banco_titular: string;
  costos_envio: {
    recoger_local: number;
    moto_mandado: number;
    paqueteria: number;
  };
  paqueterias_disponibles: string[];
}

declare global {
  interface Window {
    ClipSDK?: any;
  }
}

const PAQUETERIAS_FALLBACK = ['DHL', 'Estafeta', 'FedEx', 'Paquetexpress'];

@Component({
  selector: 'app-checkout',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './checkout.component.html',
  styleUrl: './checkout.component.css'
})
export class CheckoutComponent implements OnInit {
  carritoService = inject(CarritoService);
  private pedidoService = inject(PedidoService);
  private authService = inject(AuthService);
  private adminService = inject(AdminService);
  private router = inject(Router);

  paso = signal<1 | 2 | 3>(1);
  procesando = signal(false);
  error = signal('');
  pedidoExitoso = signal(false);
  pedidoId = signal<number | null>(null);
  estadoPedido = signal('');

  // Config de pagos del admin
  configPagos = signal<ConfigPagos>({
    pago_efectivo_activo: true,
    pago_tarjeta_activo: false,
    pago_transferencia_activo: true,
    clip_habilitado: false,
    clip_url: '',
    clip_api_key_public: '',
    banco_nombre: '',
    banco_cuenta: '',
    banco_titular: '',
    costos_envio: {
      recoger_local: 0,
      moto_mandado: 45,
      paqueteria: 150,
    },
    paqueterias_disponibles: PAQUETERIAS_FALLBACK,
  });

  // Método de entrega
  metodoEntrega = signal<MetodoEntrega>('recoger_local');

  // Dirección
  direccion = '';
  paqueteriaSeleccionada = '';

  // Método de pago
  metodoPago = signal<MetodoPago>('efectivo');

  notas = '';

  // Comprobante de transferencia
  comprobanteFile: File | null = null;
  comprobantePreview = signal<string>('');
  subiendoComprobante = signal(false);
  clipInicializando = signal(false);
  clipTarjetaLista = signal(false);
  clipTokenizando = signal(false);

  private clipApiKey = '';
  private clipSdkInstance: any = null;
  private clipCard: any = null;

  ngOnInit(): void {
    // Pre-cargar dirección del perfil del usuario
    const user = this.authService.getCurrentUser();
    if (user?.direccion) {
      this.direccion = user.direccion;
    }
    // También intentar obtener la dirección más actualizada del backend
    this.authService.getPerfil().subscribe({
      next: (res: any) => {
        if (res?.perfil?.direccion && !this.direccion) {
          this.direccion = res.perfil.direccion;
        }
      }
    });

    // Cargar configuración de pagos del admin
    this.adminService.getConfiguracionPublica().subscribe({
      next: (res: any) => {
        if (res?.ok && res.configuracion) {
          const c = res.configuracion;
          this.configPagos.set({
            pago_efectivo_activo: c.pago_efectivo_activo ?? true,
            pago_tarjeta_activo: c.pago_tarjeta_activo ?? false,
            pago_transferencia_activo: c.pago_transferencia_activo ?? true,
            clip_habilitado: c.clip_habilitado ?? false,
            clip_url: (c.clip_url || '').toString().trim(),
            clip_api_key_public: (c.clip_api_key_public || '').toString().trim(),
            banco_nombre: c.banco_nombre || '',
            banco_cuenta: c.banco_cuenta || '',
            banco_titular: c.banco_titular || '',
            costos_envio: {
              recoger_local: this.toCosto(c.costos_envio?.recoger_local, 0),
              moto_mandado: this.toCosto(c.costos_envio?.moto_mandado, 45),
              paqueteria: this.toCosto(c.costos_envio?.paqueteria, 150),
            },
            paqueterias_disponibles: this.normalizarPaqueterias(c.paqueterias_disponibles),
          });
        }
      }
    });
  }

  private toCosto(val: unknown, fallback: number): number {
    const parsed = Number(val);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Number(parsed.toFixed(2));
  }

  private normalizarPaqueterias(raw: unknown): string[] {
    if (!Array.isArray(raw)) return PAQUETERIAS_FALLBACK;
    const unicas = Array.from(
      new Set(
        raw
          .map(v => String(v || '').trim())
          .filter(v => !!v)
      )
    );
    return unicas.length ? unicas : PAQUETERIAS_FALLBACK;
  }

  get paqueteriasDisponiblesLimpias(): string[] {
    return this.normalizarPaqueterias(this.configPagos().paqueterias_disponibles);
  }

  get usuario() {
    return this.authService.getCurrentUser();
  }

  get costoEnvio(): number {
    return Number(this.configPagos().costos_envio[this.metodoEntrega()] || 0);
  }

  get totalFinal(): number {
    return this.carritoService.subtotal() - this.carritoService.descuento() + this.costoEnvio;
  }

  // ============================================
  // REGLAS DE MÉTODOS DE PAGO POR ENTREGA
  // ============================================

  /**
   * Devuelve la lista de métodos de pago disponibles según el método de entrega
   * y la configuración del admin
   */
  get metodosPagoDisponibles(): { id: MetodoPago; nombre: string; disponible: boolean; razon: string }[] {
    const entrega = this.metodoEntrega();
    const config = this.configPagos();

    // Transferencia requiere que el admin haya dado de alta banco Y cuenta
    const transferenciaConfigurada = !!(config.banco_nombre && config.banco_cuenta);
    const transferenciaDisponible = config.pago_transferencia_activo && transferenciaConfigurada;
    const razonTransferencia = !config.pago_transferencia_activo
      ? 'No habilitado por el administrador'
      : !transferenciaConfigurada
        ? 'Por el momento no se pueden realizar pedidos por transferencia'
        : '';

    const metodos: { id: MetodoPago; nombre: string; disponible: boolean; razon: string }[] = [];

    if (entrega === 'recoger_local') {
      metodos.push({
        id: 'efectivo',
        nombre: 'Efectivo',
        disponible: config.pago_efectivo_activo,
        razon: config.pago_efectivo_activo ? '' : 'No habilitado por el administrador',
      });
      metodos.push({
        id: 'tarjeta',
        nombre: 'Tarjeta de crédito / débito',
        disponible: config.pago_tarjeta_activo && config.clip_habilitado,
        razon: (!config.pago_tarjeta_activo || !config.clip_habilitado) ? 'No habilitado por el administrador' : '',
      });
      metodos.push({
        id: 'transferencia',
        nombre: 'Transferencia',
        disponible: transferenciaDisponible,
        razon: razonTransferencia,
      });
    } else if (entrega === 'moto_mandado' || entrega === 'paqueteria') {
      metodos.push({
        id: 'efectivo',
        nombre: 'Efectivo',
        disponible: false,
        razon: 'No autorizado para envío a domicilio',
      });
      metodos.push({
        id: 'tarjeta',
        nombre: 'Tarjeta de crédito / débito',
        disponible: config.pago_tarjeta_activo && config.clip_habilitado,
        razon: (!config.pago_tarjeta_activo || !config.clip_habilitado) ? 'No habilitado por el administrador' : '',
      });
      metodos.push({
        id: 'transferencia',
        nombre: 'Transferencia',
        disponible: transferenciaDisponible,
        razon: razonTransferencia,
      });
    }

    return metodos;
  }

  /** True si no hay ningún método de pago disponible para el método de entrega seleccionado */
  get sinMetodosPago(): boolean {
    return this.metodosPagoDisponibles.every(m => !m.disponible);
  }

  seleccionarEntrega(metodo: MetodoEntrega): void {
    this.metodoEntrega.set(metodo);
    this.carritoService.setMetodoEntrega(metodo);
    // Reset método de pago al cambiar entrega
    this.metodoPago.set('efectivo');
    this.comprobanteFile = null;
    this.comprobantePreview.set('');
    if (metodo !== 'paqueteria') {
      this.paqueteriaSeleccionada = '';
    }
  }

  seleccionarPago(metodo: MetodoPago): void {
    this.metodoPago.set(metodo);
    // Reset comprobante si no es transferencia
    if (metodo !== 'transferencia') {
      this.comprobanteFile = null;
      this.comprobantePreview.set('');
    }
    if (metodo !== 'tarjeta') {
      this.clipTarjetaLista.set(false);
      this.clipCard = null;
      this.clipSdkInstance = null;
    }
  }

  puedeAvanzarPaso1(): boolean {
    const m = this.metodoEntrega();
    if (m === 'moto_mandado' || m === 'paqueteria') {
      if (m === 'paqueteria' && !this.paqueteriaSeleccionada.trim()) {
        return false;
      }
      return this.direccion.trim().length > 5;
    }
    return true;
  }

  puedeAvanzarPaso2(): boolean {
    const pago = this.metodoPago();
    // Verificar que el método seleccionado esté disponible
    const metodo = this.metodosPagoDisponibles.find(m => m.id === pago);
    if (!metodo || !metodo.disponible) return false;
    // Si es transferencia, necesita comprobante
    if (pago === 'transferencia') {
      return !!this.comprobanteFile || this.comprobantePreview().length > 0;
    }
    return true;
  }

  irAPaso(paso: 1 | 2 | 3): void {
    if (paso <= this.paso()) {
      this.paso.set(paso);
    }
  }

  siguiente(): void {
    if (this.paso() === 1 && this.puedeAvanzarPaso1()) {
      // Auto-seleccionar primer método de pago disponible
      const primerDisponible = this.metodosPagoDisponibles.find(m => m.disponible);
      if (primerDisponible) {
        this.metodoPago.set(primerDisponible.id);
      }
      this.paso.set(2);
    } else if (this.paso() === 2 && this.puedeAvanzarPaso2()) {
      this.paso.set(3);
      if (this.metodoPago() === 'tarjeta') {
        setTimeout(() => {
          this.prepararCheckoutClip().catch((err) => {
            this.error.set(err instanceof Error ? err.message : 'No se pudo inicializar Clip.');
          });
        }, 0);
      }
    }
  }

  anterior(): void {
    if (this.paso() > 1) {
      this.paso.update(p => (p - 1) as 1 | 2 | 3);
    }
  }

  // ============================================
  // COMPROBANTE DE TRANSFERENCIA
  // ============================================

  onComprobanteSeleccionado(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    // Validar tipo
    if (!file.type.startsWith('image/')) {
      this.error.set('Solo se permiten imágenes (JPG, PNG, etc.)');
      return;
    }

    // Validar tamaño (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
      this.error.set('La imagen no debe superar 5MB');
      return;
    }

    this.comprobanteFile = file;
    this.error.set('');

    // Preview
    const reader = new FileReader();
    reader.onload = (e) => {
      this.comprobantePreview.set(e.target?.result as string);
    };
    reader.readAsDataURL(file);
  }

  eliminarComprobante(): void {
    this.comprobanteFile = null;
    this.comprobantePreview.set('');
  }

  // ============================================
  // CONFIRMAR PEDIDO
  // ============================================

  async confirmarPedido(): Promise<void> {
    if (this.procesando()) return;

    this.procesando.set(true);
    this.error.set('');

    let cardTokenId = '';
    if (this.metodoPago() === 'tarjeta') {
      this.clipTokenizando.set(true);
      try {
        cardTokenId = await this.obtenerCardTokenId();
      } catch (err) {
        this.procesando.set(false);
        this.clipTokenizando.set(false);
        this.error.set(err instanceof Error ? err.message : 'No se pudo tokenizar la tarjeta con Clip.');
        return;
      }
      this.clipTokenizando.set(false);
    }

    // Si hay comprobante, subirlo primero
    if (this.metodoPago() === 'transferencia' && this.comprobanteFile) {
      this.subiendoComprobante.set(true);
      this.authService.uploadComprobantePago(this.comprobanteFile, 'comprobantes_pedidos').subscribe({
        next: (res: any) => {
          this.subiendoComprobante.set(false);
          if (res.url) {
            this.crearPedidoConComprobante(res.url, cardTokenId);
          } else {
            this.procesando.set(false);
            this.error.set('Error al subir el comprobante');
          }
        },
        error: () => {
          this.subiendoComprobante.set(false);
          this.procesando.set(false);
          this.error.set('Error al subir el comprobante. Intenta de nuevo.');
        }
      });
    } else {
      this.crearPedidoConComprobante('', cardTokenId);
    }
  }

  private async prepararCheckoutClip(): Promise<void> {
    if (this.metodoPago() !== 'tarjeta') return;
    if (this.clipTarjetaLista()) return;
    if (this.clipInicializando()) return;
    this.clipInicializando.set(true);
    try {
      const cfgRes = await firstValueFrom(this.pedidoService.clipConfig());
      const keyFromApi = String(cfgRes?.clip_api_key_public || '').trim();
      const keyFromPublicCfg = String(this.configPagos().clip_api_key_public || '').trim();
      this.clipApiKey = keyFromApi || keyFromPublicCfg;
      if (!this.clipApiKey) {
        throw new Error('No hay API Key pública de Clip configurada.');
      }
      await this.cargarClipSdk();
      if (!window.ClipSDK) {
        throw new Error('No se pudo cargar clip-sdk.js');
      }
      const container = document.getElementById('clip-checkout-sdk');
      if (!container) {
        throw new Error('No se encontró el contenedor del formulario de tarjeta.');
      }
      container.replaceChildren();
      this.clipSdkInstance = new window.ClipSDK(this.clipApiKey);
      this.clipCard = this.clipSdkInstance.element.create('Card', { locale: 'es', theme: 'dark' });
      this.clipCard.mount('clip-checkout-sdk');
      this.clipTarjetaLista.set(true);
    } finally {
      this.clipInicializando.set(false);
    }
  }

  private cargarClipSdk(): Promise<void> {
    if (window.ClipSDK) return Promise.resolve();
    const scriptId = 'clip-sdk-js';
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    if (existing) {
      return new Promise((resolve, reject) => {
        if ((window as any).ClipSDK) {
          resolve();
          return;
        }
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error('No se pudo cargar SDK de Clip.')), { once: true });
      });
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = 'https://sdk.clip.mx/js/clip-sdk.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('No se pudo cargar SDK de Clip.'));
      document.head.appendChild(script);
    });
  }

  private async obtenerCardTokenId(): Promise<string> {
    await this.prepararCheckoutClip();
    if (!this.clipCard || typeof this.clipCard.cardToken !== 'function') {
      throw new Error('El formulario de tarjeta Clip no está listo.');
    }
    const result = await this.withTimeout(
      Promise.resolve(this.clipCard.cardToken()),
      30000,
      'Clip tardó demasiado en tokenizar la tarjeta. Verifica los datos de la tarjeta o intenta nuevamente.'
    );
    const token = String(result?.id || '').trim();
    if (!token) {
      throw new Error('Clip no devolvió Card Token ID.');
    }
    return token;
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  private redirigirAClip(url: string): void {
    let normalized: string;
    try {
      const paymentUrl = new URL(String(url || '').trim());
      if (paymentUrl.protocol !== 'https:') throw new Error('Protocolo no permitido');
      normalized = paymentUrl.toString();
    } catch {
      this.error.set('El backend no devolvió una URL segura de pago.');
      return;
    }
    // Intenta abrir en nueva pestaña; si el navegador lo bloquea, redirige en la misma pestaña.
    const popup = window.open(normalized, '_blank', 'noopener,noreferrer');
    if (popup) {
      popup.focus();
      return;
    }
    window.location.href = normalized;
  }

  private crearPedidoConComprobante(comprobanteUrl: string, cardTokenId = ''): void {
    const items = this.carritoService.items().map(i => ({
      producto_id: Number(i.productoId),
      cantidad: i.cantidad,
    }));

    const req: any = {
      items,
      metodo_entrega: this.metodoEntrega(),
      metodo_pago: this.metodoPago(),
      direccion_entrega: this.direccion,
      codigo_descuento: this.carritoService.getCodigoDescuento() || undefined,
      notas: this.armarNotasPedido(),
      comprobante_url: comprobanteUrl,
    };

    this.pedidoService.crearPedido(req).subscribe({
      next: (res: any) => {
        this.procesando.set(false);
        if (res.ok) {
          const nuevoPedidoId = Number(res.pedido_id || 0);
          if (this.metodoPago() === 'tarjeta' && nuevoPedidoId > 0) {
            this.procesando.set(true);
            this.pedidoService.clipIntentarPago({
              tipo: 'pedido',
              pedido_id: nuevoPedidoId,
              card_token_id: cardTokenId || undefined,
              cliente_email: String(this.usuario?.email || '').trim() || undefined,
              cliente_phone: String((this.usuario as any)?.telefono || (this.usuario as any)?.phone || '').trim() || undefined,
            }).subscribe({
              next: (clipRes: any) => {
                this.procesando.set(false);
                const paymentUrl = String(clipRes?.checkout_url || '').trim();
                if (clipRes?.ok && paymentUrl) {
                  this.carritoService.vaciarCarrito();
                  this.redirigirAClip(paymentUrl);
                  return;
                }
                if (clipRes?.ok && clipRes?.pago_directo) {
                  const estadoPago = this.pedidoService.normalizarEstadoPago(clipRes?.estado_pago);
                  if (estadoPago === 'rechazado' || estadoPago === 'inconsistente') {
                    this.error.set('Clip no confirmó el pago. Consulta el estado del pedido antes de reintentar.');
                    return;
                  }
                  this.pedidoExitoso.set(true);
                  this.pedidoId.set(nuevoPedidoId);
                  this.estadoPedido.set(estadoPago === 'confirmado' ? 'pagado' : 'comprobando_pago');
                  if (estadoPago === 'confirmado') this.carritoService.vaciarCarrito();
                  return;
                }
                const errMsg = String(clipRes?.error || '').trim();
                if (errMsg && !/traceback|exception|sql/i.test(errMsg)) {
                  this.error.set(errMsg);
                } else {
                  this.error.set('No se pudo iniciar el pago con Clip. Consulta el estado del pedido antes de reintentar.');
                }
              },
              error: (clipErr: any) => {
                this.procesando.set(false);
                const detalle = String(clipErr?.error?.error || clipErr?.error?.detail || '').trim();
                const msg = detalle && !/traceback|exception|sql/i.test(detalle)
                  ? detalle
                  : 'No se pudo iniciar el pago con Clip. Consulta el estado del pedido antes de reintentar.';
                this.error.set(msg);
              }
            });
            return;
          }

          this.pedidoExitoso.set(true);
          this.pedidoId.set(res.pedido_id);
          this.estadoPedido.set(res.estado);
          this.carritoService.vaciarCarrito();
        } else {
          this.error.set(res.error || 'Error al crear el pedido');
        }
      },
      error: (err: any) => {
        this.procesando.set(false);
        const status = Number(err?.status || 0);
        const detalle = err?.error?.error || err?.error?.detail || err?.message || '';
        const msg = status === 404
          ? 'El endpoint de pedidos no está disponible en backend (/api/pedidos/crear/).'
          : (detalle || 'Error al procesar el pedido. Intenta de nuevo.');
        this.error.set(msg);
      }
    });
  }

  irAPedidos(): void {
    this.router.navigate(['/cliente/pedidos']);
  }

  irAProductos(): void {
    this.router.navigate(['/cliente/productos']);
  }

  getNombreEntrega(metodo: string): string {
    const nombres: Record<string, string> = {
      'recoger_local': 'Recoger en local',
      'moto_mandado': 'Moto mandado',
      'paqueteria': 'Paquetería',
    };
    return nombres[metodo] || metodo;
  }

  private armarNotasPedido(): string {
    const base = (this.notas || '').trim();
    if (this.metodoEntrega() !== 'paqueteria' || !this.paqueteriaSeleccionada.trim()) {
      return base;
    }
    const extra = `[Paquetería solicitada: ${this.paqueteriaSeleccionada.trim()}]`;
    return base ? `${base}\n${extra}` : extra;
  }

  getNombrePago(metodo: string): string {
    const nombres: Record<string, string> = {
      'efectivo': 'Efectivo',
      'tarjeta': 'Tarjeta de crédito / débito',
      'transferencia': 'Transferencia',
    };
    return nombres[metodo] || metodo;
  }

  get esTransferencia(): boolean {
    return this.metodoPago() === 'transferencia';
  }

  get esTarjetaClip(): boolean {
    return this.metodoPago() === 'tarjeta';
  }

  get mensajeExito(): string {
    if (this.estadoPedido() === 'comprobando_pago') {
      return 'Estamos verificando tu comprobante de transferencia. Te notificaremos cuando sea validado.';
    }
    return 'Tu pedido ha sido registrado exitosamente.';
  }

  getIconoPago(metodo: string): string {
    const iconos: Record<string, string> = {
      'efectivo': '$',
      'tarjeta': '▰',
      'transferencia': '⇄',
    };
    return iconos[metodo] || '';
  }
}
