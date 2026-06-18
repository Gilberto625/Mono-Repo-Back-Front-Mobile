// ============================================
// MODELOS DEL SISTEMA STYLO BARBER CONNECT
// ============================================

// Roles del sistema
export type RolUsuario = 'cliente' | 'secretaria' | 'barbero' | 'admin';

// Estados de citas
export type EstadoCita = 'pendiente' | 'confirmada' | 'en_curso' | 'completada' | 'cancelada' | 'no_asistio';

// Estados de pago
export type EstadoPago = 'pendiente' | 'parcial' | 'completado' | 'reembolsado';

// Métodos de pago
export type MetodoPago = 'efectivo' | 'tarjeta' | 'transferencia' | 'mercado_pago';

// Tipos de demanda
export type TipoDemanda = 'alta' | 'media' | 'baja';

// Métodos de entrega
export type MetodoEntrega = 'recoger_local' | 'moto_mandado' | 'paqueteria';

// Estados de pedido
export type EstadoPedido = 'pendiente' | 'confirmado' | 'preparando' | 'enviado' | 'entregado' | 'cancelado';

// ============================================
// INTERFACES PRINCIPALES
// ============================================

export interface Usuario {
  id: string;
  email: string;
  nombre: string;
  apellidos: string;
  telefono: string;
  bio?: string;
  fechaNacimiento?: Date;
  rol: RolUsuario;
  avatar?: string;
  fechaRegistro: Date;
  activo: boolean;
  // Campos específicos de cliente
  puntos?: number;
  nivelCliente?: 'normal' | 'vip';
  citasIncumplidas?: number;
  citasCumplidas?: number;
  requiereAnticipo?: boolean;
}

export interface Servicio {
  id: string;
  nombre: string;
  descripcion: string;
  precio: number;
  duracionMinutos: number;
  imagen?: string;
  /** Hasta 5 URLs para galería en detalle (cortes, barbas, etc.) */
  imagenesGaleria?: string[];
  categoria: 'corte' | 'barba' | 'tratamiento' | 'combo';
  activo: boolean;
  popular?: boolean;
  /** Etiquetas para recomendador: rostro-ovalado, estilo-moderno, etc. */
  etiquetas?: string[];
}

export interface Barbero {
  id: string;
  usuario: Usuario;
  especialidades: string[];
  tiemposServicio: TiempoServicio[];
  activo: boolean;
  calificacion?: number;
  /** Días de trabajo del barbero en índice 0=Lunes .. 6=Domingo */
  dias_trabajo?: number[];
  /** JSON: lista de {fecha, motivo, estado} - días en que no puede agendar */
  dias_libres?: string;
  /** JSON: lista de {fecha_solicitud, fecha_inicio, fecha_fin, estado} - periodos de vacaciones aprobados bloquean agendar */
  periodos_vacaciones?: string;
}

export interface TiempoServicio {
  servicioId: string;
  duracionMinutos: number;
}

export interface Silla {
  id: string;
  nombre: string;
  barberoAsignado?: string;
  activa: boolean;
}

export interface HorarioDisponible {
  fecha: Date;
  hora: string;
  disponible: boolean;
  barberoId?: string;
  sillaId?: string;
}

export interface Cita {
  id: string;
  clienteId: string;
  cliente?: Usuario;
  barberoId: string;
  barbero?: Barbero;
  servicioId: string;
  servicio?: Servicio;
  sillaId?: string;
  silla?: Silla;
  fecha: Date;
  hora: string;
  duracionMinutos: number;
  estado: EstadoCita;
  estadoPago: EstadoPago;
  precioTotal: number;
  anticipo: number;
  anticipoPagado: boolean;
  metodoPago?: MetodoPago;
  notas?: string;
  fechaCreacion: Date;
  fechaModificacion?: Date;
  recordatorioEnviado?: boolean;
}

export interface Producto {
  id: string;
  nombre: string;
  marca?: string;
  descripcion: string;
  precio: number;
  /** Presentación: ej. 250 ml, 100 g (no es precio). */
  pesoVolumen?: string;
  imagen?: string;
  /** Hasta 5 URLs para galería en detalle */
  imagenesGaleria?: string[];
  categoria: 'cabello' | 'barba' | 'accesorios' | 'kit' | 'facial';
  stock: number;
  stockMinimo: number;
  activo: boolean;
  destacado?: boolean;
  nuevo?: boolean;
}

export interface ItemCarrito {
  productoId: string;
  producto?: Producto;
  cantidad: number;
  precioUnitario: number;
}

export interface Carrito {
  items: ItemCarrito[];
  subtotal: number;
  descuento: number;
  costoEnvio: number;
  total: number;
}

export interface Pedido {
  id: string;
  clienteId: string;
  cliente?: Usuario;
  items: ItemCarrito[];
  subtotal: number;
  descuento: number;
  costoEnvio: number;
  total: number;
  metodoPago: MetodoPago;
  estadoPago: EstadoPago;
  estado: EstadoPedido;
  metodoEntrega: MetodoEntrega;
  direccionEntrega?: Direccion;
  fechaCreacion: Date;
  fechaEntrega?: Date;
  notas?: string;
}

export interface Direccion {
  calle: string;
  numero: string;
  colonia: string;
  ciudad: string;
  codigoPostal: string;
  referencias?: string;
}

export interface Apartado {
  id: string;
  clienteId: string;
  productoId: string;
  producto?: Producto;
  cantidad: number;
  fechaApartado: Date;
  fechaLimite: Date;
  anticipoPagado: number;
  estado: 'activo' | 'recogido' | 'cancelado' | 'vencido';
}

export interface Venta {
  id: string;
  tipo: 'servicio' | 'producto';
  clienteId?: string;
  cliente?: Usuario;
  items: ItemVenta[];
  total: number;
  metodoPago: MetodoPago;
  fecha: Date;
  atendidoPor: string;
  notas?: string;
}

export interface ItemVenta {
  tipo: 'servicio' | 'producto';
  itemId: string;
  nombre: string;
  cantidad: number;
  precioUnitario: number;
  subtotal: number;
}

export interface Transferencia {
  id: string;
  tipo: 'cita' | 'pedido' | 'apartado';
  referenciaId: string;
  clienteId: string;
  cliente?: Usuario;
  monto: number;
  idOperacion: string;
  comprobante?: string;
  estado: 'pendiente' | 'validada' | 'rechazada';
  fechaEnvio: Date;
  fechaValidacion?: Date;
  validadoPor?: string;
  notas?: string;
}

export interface ConfiguracionSistema {
  diasAnticipadosAltaDemanda: number;
  diasAnticipadosBajaDemanda: number;
  diasCancelacionAltaDemanda: number;
  diasCancelacionBajaDemanda: number;
  porcentajeAnticipo: number;
  citasSinAnticipoNuevoCliente: number;
  citasConAnticipoIncumplimiento: number;
  esperaMaximaMinutos: number;
  costoMotoMandadoMin: number;
  costoMotoMandadoMax: number;
}

export interface DiaCalendario {
  fecha: Date;
  tipoDemanda: TipoDemanda;
  festivo?: boolean;
  notas?: string;
}

export interface Promocion {
  id: string;
  titulo: string;
  descripcion: string;
  tipo: 'porcentaje' | 'monto_fijo' | '2x1';
  valor: number;
  codigoPromo?: string;
  fechaInicio: Date;
  fechaFin: Date;
  aplicaA: 'servicios' | 'productos' | 'ambos';
  serviciosIncluidos?: string[];
  productosIncluidos?: string[];
  activa: boolean;
}

export interface Notificacion {
  id: string;
  usuarioId: string;
  tipo: 'recordatorio_cita' | 'confirmacion' | 'cancelacion' | 'promocion' | 'pedido';
  titulo: string;
  mensaje: string;
  leida: boolean;
  fecha: Date;
  accionUrl?: string;
}

export interface ReporteVentas {
  fecha: Date;
  totalServicios: number;
  totalProductos: number;
  cantidadCitas: number;
  cantidadVentas: number;
  ingresoTotal: number;
  topServicios: { nombre: string; cantidad: number; ingresos: number }[];
  topProductos: { nombre: string; cantidad: number; ingresos: number }[];
}

export interface MetricasNegocio {
  citasHoy: number;
  citasPendientes: number;
  ventasHoy: number;
  ingresosDia: number;
  ingresosSemana: number;
  ingresosMes: number;
  clientesNuevos: number;
  productosStockBajo: number;
  diasMasConcurridos: { dia: string; porcentaje: number }[];
  horasMasConcurridas: { hora: string; porcentaje: number }[];
}
