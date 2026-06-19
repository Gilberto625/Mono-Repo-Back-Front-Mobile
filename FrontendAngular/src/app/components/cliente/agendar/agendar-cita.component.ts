import { Component, inject, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, ActivatedRoute } from '@angular/router';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { CitaService } from '../../../services/cita.service';
import { ServicioService } from '../../../services/servicio.service';
import { AdminService, HorarioDiaConfig } from '../../../services/admin.service';
import { AuthService } from '../../../services/auth.service';
import { PedidoService } from '../../../services/pedido.service';
import { Servicio, Barbero } from '../../../models';
import { firstValueFrom } from 'rxjs';

type PasoAgenda = 1 | 2 | 3 | 4 | 5;

interface SlotHorario {
  hora: string;
  disponible: boolean;
}

@Component({
  selector: 'app-agendar-cita',
  standalone: true,
  imports: [CommonModule, RouterModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './agendar-cita.component.html',
  styleUrl: './agendar-cita.component.css'
})
export class AgendarCitaComponent implements OnInit {
  private citaService = inject(CitaService);
  private servicioService = inject(ServicioService);
  private adminService = inject(AdminService);
  private authService = inject(AuthService);
  private pedidoService = inject(PedidoService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  pasoActual = signal<PasoAgenda>(1);
  servicioSeleccionado = signal<Servicio | null>(null);
  /** Servicios adicionales (tratamientos, barba, etc.); el principal sigue en servicioSeleccionado. */
  complementosSeleccionados = signal<Servicio[]>([]);
  barberoSeleccionado = signal<Barbero | null>(null);
  fechaSeleccionada = signal<Date | null>(null);
  horaSeleccionada = signal<string | null>(null);
  metodoPago = signal<'tarjeta' | 'transferencia' | 'mercado_pago'>('tarjeta');

  // Barberos filtrados por servicio (del backend)
  barberosDisponibles = signal<Barbero[]>([]);
  cargandoBarberos = signal(false);

  // Horarios del backend
  horariosDisponibles = signal<SlotHorario[]>([]);
  cargandoHorarios = signal(false);

  // Horarios de atención (para el calendario)
  private horariosAtencion = signal<HorarioDiaConfig[] | null>(null);

  // Política de pago
  politicaPago = signal<{
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
  } | null>(null);
  cargandoPolitica = signal(false);
  quierePagarAnticipo = signal(false);
  anticipoVoluntario = signal<number>(0); // Monto libre que el cliente quiere dejar
  metodoPagoAnticipo = signal<'transferencia' | 'tarjeta'>('transferencia');

  // Cupón en paso 4 (servicios)
  codigoDescuento = signal('');
  promoAplicada = signal<{
    codigo: string;
    nombre: string;
    tipo_descuento: string;
    valor_descuento: number;
    descuento: number;
  } | null>(null);
  validandoPromocion = signal(false);
  mensajePromocion = signal('');
  errorPromocion = signal('');

  // Clip para anticipo/pago en cita
  clipCargando = signal(false);
  clipTokenizando = signal(false);
  clipError = signal('');
  private clipSdkListo = false;
  private clipCardMounted = false;
  private clipPublicKey = '';
  private clipSdkInstance: any = null;
  private clipCard: any = null;

  get tarjetaCargada(): boolean {
    return this.clipCardMounted;
  }

  // Comprobante de pago (voucher de transferencia)
  comprobanteFile = signal<File | null>(null);
  comprobantePreview = signal<string>('');
  subiendoComprobante = signal(false);

  // Error
  errorCita = signal('');
  exitoCita = signal('');
  creandoCita = signal(false);

  // Filtro por categoría
  categoriaFiltro = signal<string>('todos');

  readonly CATEGORIAS = [
    { value: 'todos', label: 'Todos' },
    { value: 'corte', label: 'Cortes' },
    { value: 'barba', label: 'Barbas' },
    { value: 'combo', label: 'Paquetes' },
    { value: 'tratamiento', label: 'Tratamientos' }
  ];

  get servicios() { return this.servicioService.servicios(); }

  get serviciosFiltrados(): Servicio[] {
    const cat = this.categoriaFiltro();
    const todos = this.servicios.filter(s => s.activo);
    if (cat === 'todos') return todos;
    return todos.filter(s => s.categoria === cat);
  }

  filtrarCategoria(cat: string): void {
    this.categoriaFiltro.set(cat);
  }

  ngOnInit(): void {
    this.servicioService.loadServiciosPublicos();

    // Cargar horarios de atención para el calendario
    this.adminService.getConfiguracionPublica().subscribe({
      next: (res) => {
        if (res?.ok && res.configuracion?.horarios_por_dia) {
          this.horariosAtencion.set(res.configuracion.horarios_por_dia);
          this.citaService.setHorariosAtencion(res.configuracion.horarios_por_dia);
        }
      }
    });

    // Pre-seleccionar servicio si viene por queryParam
    this.route.queryParams.subscribe(params => {
      const servicioId = params['servicio'];
      if (servicioId) {
        const servicio = this.servicioService.getServicioById(servicioId);
        if (servicio) {
          this.servicioSeleccionado.set(servicio);
          this.complementosSeleccionados.set([]);
        }
      }
    });

    // Cargar política de pago
    this.cargarPoliticaPago();
  }

  private cargarPoliticaPago(): void {
    const user = this.authService.getCurrentUser();
    if (!user?.id) return;
    this.cargandoPolitica.set(true);
    this.adminService.getCitaPoliticaPago(Number(user.id)).subscribe({
      next: (res) => {
        if (res?.ok) {
          this.politicaPago.set(res);
          if (res.penalizado) {
            const minimo = Math.ceil((this.precioBaseServicio || 0) * (Number(res.porcentaje_anticipo || 50) / 100));
            this.anticipoVoluntario.set(minimo);
          }
        }
        this.cargandoPolitica.set(false);
      },
      error: () => {
        // Fallback: cargar al menos datos bancarios de la configuración pública
        this.adminService.getConfiguracionPublica().subscribe({
          next: (cfgRes) => {
            if (cfgRes?.ok && cfgRes.configuracion) {
              const cfg = cfgRes.configuracion;
              const tieneBanco = !!(cfg.banco_nombre && cfg.banco_cuenta);
              this.politicaPago.set({
                requiere_anticipo: false,
                porcentaje_anticipo: cfg.porcentaje_anticipo || 50,
                penalizado: false,
                total_inasistencias: 0,
                citas_restantes_penalizacion: 0,
                citas_penalizacion_total: cfg.citas_penalizacion || 3,
                tiempo_espera_maximo: cfg.tiempo_espera_maximo || 10,
                tiene_banco: tieneBanco,
                banco_nombre: cfg.banco_nombre || '',
                banco_cuenta: cfg.banco_cuenta || '',
                banco_titular: cfg.banco_titular || '',
              });
            }
            this.cargandoPolitica.set(false);
          },
          error: () => {
            this.cargandoPolitica.set(false);
          }
        });
      }
    });
  }

  // ============================================
  // PASO 1: SELECCIONAR SERVICIO
  // ============================================

  seleccionarServicio(servicio: Servicio): void {
    this.servicioSeleccionado.set(servicio);
    this.complementosSeleccionados.set([]);
    // Resetear pasos siguientes
    this.barberoSeleccionado.set(null);
    this.fechaSeleccionada.set(null);
    this.horaSeleccionada.set(null);
    this.horariosDisponibles.set([]);
    this.promoAplicada.set(null);
    this.codigoDescuento.set('');
    this.errorPromocion.set('');
    this.mensajePromocion.set('');
    if (this.anticipoObligatorio) {
      this.anticipoVoluntario.set(this.montoAnticipoObligatorio);
    }
  }

  get serviciosComplementoDisponibles(): Servicio[] {
    const p = this.servicioSeleccionado();
    if (!p) return [];
    return this.servicios.filter(s => s.activo && s.id !== p.id);
  }

  get serviciosComplementoFiltrados(): Servicio[] {
    const base = this.serviciosComplementoDisponibles;
    const cat = this.categoriaFiltro();
    if (cat === 'todos') return base;
    return base.filter(s => s.categoria === cat);
  }

  complementoSeleccionado(servicio: Servicio): boolean {
    return this.complementosSeleccionados().some(x => x.id === servicio.id);
  }

  toggleComplemento(servicio: Servicio): void {
    const cur = this.complementosSeleccionados();
    if (cur.some(x => x.id === servicio.id)) {
      this.complementosSeleccionados.set(cur.filter(x => x.id !== servicio.id));
    } else {
      this.complementosSeleccionados.set([...cur, servicio]);
    }
  }

  get serviciosReservaCompleta(): Servicio[] {
    const p = this.servicioSeleccionado();
    if (!p) return [];
    return [p, ...this.complementosSeleccionados()];
  }

  get totalDuracionReserva(): number {
    return this.serviciosReservaCompleta.reduce((acc, s) => acc + (Number(s.duracionMinutos) || 0), 0);
  }

  etiquetaCategoriaServicio(codigo: string): string {
    const f = this.CATEGORIAS.find(c => c.value === codigo);
    return f?.label || codigo;
  }

  private buildNotasComplementos(): string {
    const comp = this.complementosSeleccionados();
    if (!comp.length) return '';
    const parts = comp.map(s => `${s.nombre} ($${Number(s.precio).toFixed(2)} MXN)`);
    return `Complementos: ${parts.join('; ')}`;
  }

  /** Barberos que cubren el servicio principal y todos los complementos (sin cambiar API). */
  private cargarBarberosParaBundle(): void {
    const primary = this.servicioSeleccionado();
    if (!primary) return;
    const extraIds = this.complementosSeleccionados().map(s => Number(s.id));
    const primaryId = Number(primary.id);
    const requiredIds = [primaryId, ...extraIds];

    this.cargandoBarberos.set(true);
    this.barberosDisponibles.set([]);

    this.adminService.getBarberosParaAgendar(primaryId).subscribe({
      next: (res) => {
        if (res?.ok && Array.isArray(res.barberos)) {
          const barberos: Barbero[] = res.barberos
            .filter((e: any) => {
              if (e?.activo === false) return false;
              const ids = this.parseServiciosIds(e?.servicios_ids ?? e?.servicios ?? []);
              if (extraIds.length === 0) {
                return ids.length === 0 || ids.includes(primaryId);
              }
              if (!ids.length) {
                return false;
              }
              return requiredIds.every((rid) => ids.includes(rid));
            })
            .map((e: any) => ({
              id: String(e.id),
              usuario: {
                id: String(e.id),
                email: e.email,
                nombre: e.nombre || e.first_name || '',
                apellidos: e.apellido || e.apellidos || e.last_name || '',
                telefono: e.telefono || '',
                  bio: String(e.bio || '').trim() || undefined,
                rol: 'barbero',
                avatar: String(e.avatar_url || e.avatar || '').trim() || undefined,
                fechaRegistro: new Date(),
                activo: e.activo !== false
              },
              especialidades: this.parseEspecialidades(e.especialidades),
              tiemposServicio: [],
              activo: e.activo !== false,
              calificacion: 4.5,
              dias_trabajo: this.parseDiasTrabajo(e.dias_trabajo),
              dias_libres: e.dias_libres || '',
              periodos_vacaciones: e.periodos_vacaciones || '',
              servicios_ids: this.parseServiciosIds(e.servicios_ids || e.servicios || [])
            }));
          this.barberosDisponibles.set(barberos);
        }
        this.cargandoBarberos.set(false);
      },
      error: () => {
        this.cargandoBarberos.set(false);
      }
    });
  }

  private parseEspecialidades(esp: string | undefined): string[] {
    if (!esp) return [];
    try {
      const arr = typeof esp === 'string' && esp.startsWith('[') ? JSON.parse(esp) : esp.split(',').map((s: string) => s.trim()).filter(Boolean);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  private parseServiciosIds(raw: unknown): number[] {
    if (Array.isArray(raw)) {
      return raw
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v) && v > 0);
    }
    if (typeof raw === 'string' && raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed
            .map((v) => Number(v))
            .filter((v) => Number.isFinite(v) && v > 0);
        }
      } catch {
        // Ignorar y devolver vacío si no es JSON válido.
      }
    }
    return [];
  }

  private parseDiasTrabajo(raw: unknown): number[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((v) => Number(v))
      .filter((v) => Number.isFinite(v) && v >= 0 && v <= 6);
  }

  private diaSemanaIndex(fecha: Date): number {
    // JS: 0=Domingo, 1=Lunes... => 0=Lunes..6=Domingo
    const d = fecha.getDay();
    return d === 0 ? 6 : d - 1;
  }

  private barberoTrabajaEnFecha(barbero: Barbero, fecha: Date): boolean {
    const dias = Array.isArray(barbero.dias_trabajo) ? barbero.dias_trabajo : [];
    if (!dias.length) return true; // Fallback compatible si backend no envía horario laboral.
    return dias.includes(this.diaSemanaIndex(fecha));
  }

  // ============================================
  // PASO 3: SELECCIONAR BARBERO
  // ============================================

  seleccionarBarbero(barbero: Barbero): void {
    this.barberoSeleccionado.set(barbero);
    // Resetear fecha y hora
    this.fechaSeleccionada.set(null);
    this.horaSeleccionada.set(null);
    this.horariosDisponibles.set([]);
  }

  // ============================================
  // PASO 4: CALENDARIO Y HORARIOS
  // ============================================

  mesActual = new Date().getMonth();
  anioActual = new Date().getFullYear();

  get nombreMes(): string {
    const meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
                   'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    return meses[this.mesActual];
  }

  get diasCalendario(): { numero: number | null; fecha: Date | null; disponible: boolean }[] {
    const dias: { numero: number | null; fecha: Date | null; disponible: boolean }[] = [];
    const primerDia = new Date(this.anioActual, this.mesActual, 1);
    const ultimoDia = new Date(this.anioActual, this.mesActual + 1, 0);
    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const barbero = this.barberoSeleccionado();

    for (let i = 0; i < primerDia.getDay(); i++) {
      dias.push({ numero: null, fecha: null, disponible: false });
    }

    for (let d = 1; d <= ultimoDia.getDate(); d++) {
      const fecha = new Date(this.anioActual, this.mesActual, d);
      const esPasado = fecha < hoy;
      const esMuyFuturo = fecha > new Date(hoy.getTime() + 30 * 24 * 60 * 60 * 1000);
      const noDisponibleBarbero = barbero
        ? (!this.barberoTrabajaEnFecha(barbero, fecha) || this.citaService.barberoNoDisponibleEnFecha(barbero.id, fecha))
        : false;
      const negocioCerrado = !this.citaService.negocioAbiertoEnFecha(fecha);

      dias.push({
        numero: d,
        fecha,
        disponible: !esPasado && !esMuyFuturo && !noDisponibleBarbero && !negocioCerrado
      });
    }

    return dias;
  }

  seleccionarFecha(fecha: Date): void {
    this.fechaSeleccionada.set(fecha);
    this.horaSeleccionada.set(null);
    this.horariosDisponibles.set([]);
    // Consultar disponibilidad real al backend
    this.cargarHorariosDesdeBackend(fecha);
  }

  private cargarHorariosDesdeBackend(fecha: Date): void {
    const barbero = this.barberoSeleccionado();
    const servicio = this.servicioSeleccionado();
    if (!barbero || !servicio) return;

    this.cargandoHorarios.set(true);
    const fechaStr = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}`;

    this.adminService.getDisponibilidad(Number(barbero.id), fechaStr, this.totalDuracionReserva).subscribe({
      next: (res) => {
        if (res?.ok && Array.isArray(res.horarios)) {
          this.horariosDisponibles.set(res.horarios);
        }
        this.cargandoHorarios.set(false);
      },
      error: () => {
        this.cargandoHorarios.set(false);
      }
    });
  }

  seleccionarHora(hora: string): void {
    this.horaSeleccionada.set(hora);
  }

  // ============================================
  // NAVEGACIÓN DE PASOS
  // ============================================

  siguientePaso(): void {
    const p = this.pasoActual();
    if (p >= 5) return;
    if (p === 2) {
      this.cargarBarberosParaBundle();
    }
    this.pasoActual.update(n => (n + 1) as PasoAgenda);
  }

  pasoAnterior(): void {
    const p = this.pasoActual();
    if (p <= 1) return;
    if (p === 4) {
      this.fechaSeleccionada.set(null);
      this.horaSeleccionada.set(null);
      this.horariosDisponibles.set([]);
    } else if (p === 3) {
      this.barberoSeleccionado.set(null);
      this.fechaSeleccionada.set(null);
      this.horaSeleccionada.set(null);
      this.horariosDisponibles.set([]);
    }
    this.pasoActual.update(n => (n - 1) as PasoAgenda);
  }

  irAPaso(paso: PasoAgenda): void {
    const actual = this.pasoActual();
    if (paso === 1 && actual > 1) {
      this.complementosSeleccionados.set([]);
      this.barberoSeleccionado.set(null);
      this.fechaSeleccionada.set(null);
      this.horaSeleccionada.set(null);
      this.horariosDisponibles.set([]);
    } else if (paso === 2 && actual > 2) {
      this.barberoSeleccionado.set(null);
      this.fechaSeleccionada.set(null);
      this.horaSeleccionada.set(null);
      this.horariosDisponibles.set([]);
    } else if (paso === 3 && actual > 3) {
      this.fechaSeleccionada.set(null);
      this.horaSeleccionada.set(null);
      this.horariosDisponibles.set([]);
    }
    this.pasoActual.set(paso);
    if (paso === 3) {
      this.cargarBarberosParaBundle();
    }
  }

  mesAnterior(): void {
    if (this.mesActual === 0) {
      this.mesActual = 11;
      this.anioActual--;
    } else {
      this.mesActual--;
    }
  }

  mesSiguiente(): void {
    if (this.mesActual === 11) {
      this.mesActual = 0;
      this.anioActual++;
    } else {
      this.mesActual++;
    }
  }

  seleccionarMetodoPago(metodo: 'tarjeta' | 'transferencia' | 'mercado_pago'): void {
    this.metodoPago.set(metodo);
  }

  // ============================================
  // HELPERS
  // ============================================

  getInicialesBarbero(): string {
    const barbero = this.barberoSeleccionado();
    if (barbero?.usuario) {
      const n = barbero.usuario.nombre?.[0] || '';
      const a = barbero.usuario.apellidos?.[0] || '';
      return (n + a).toUpperCase() || 'BB';
    }
    return 'BB';
  }

  getBarberoAvatar(barbero: Barbero | null): string {
    const avatar = String(barbero?.usuario?.avatar || '').trim();
    if (avatar) return avatar;
    const nombre = String(barbero?.usuario?.nombre || '').trim();
    const apellidos = String(barbero?.usuario?.apellidos || '').trim();
    const iniciales = `${nombre.charAt(0)}${apellidos.charAt(0)}`.toUpperCase() || 'BB';
    const svg = `
      <svg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'>
        <rect width='96' height='96' rx='48' fill='#1f3a36'/>
        <circle cx='48' cy='48' r='46' fill='none' stroke='#c8a864' stroke-width='2'/>
        <text x='48' y='55' text-anchor='middle' font-family='Arial, sans-serif' font-size='30' fill='#f5f1e8'>${iniciales}</text>
      </svg>
    `;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  formatearFechaCompleta(fecha: Date): string {
    const opciones: Intl.DateTimeFormatOptions = {
      weekday: 'long',
      day: 'numeric',
      month: 'long'
    };
    return fecha.toLocaleDateString('es-MX', opciones);
  }

  /** El cliente está penalizado y DEBE pagar anticipo obligatorio */
  get anticipoObligatorio(): boolean {
    const pol = this.politicaPago();
    return pol?.penalizado === true;
  }

  /** Suma precio del servicio principal + complementos (un solo cargo en cita). */
  get precioBaseServicio(): number {
    return this.serviciosReservaCompleta.reduce((acc, s) => acc + (Number(s.precio) || 0), 0);
  }

  get descuentoAplicadoMonto(): number {
    return Math.max(0, Number(this.promoAplicada()?.descuento || 0));
  }

  get totalServicioFinal(): number {
    const total = this.precioBaseServicio - this.descuentoAplicadoMonto;
    return Math.max(0, Math.round(total * 100) / 100);
  }

  /** Monto del anticipo obligatorio (por penalización) */
  get montoAnticipoObligatorio(): number {
    const precio = this.totalServicioFinal;
    const pol = this.politicaPago();
    const porcentaje = pol?.porcentaje_anticipo || 50;
    return Math.ceil(precio * porcentaje / 100);
  }

  /** Monto final que se pagará como anticipo */
  get montoAnticipo(): number {
    return this.anticipoObligatorio ? this.montoAnticipoObligatorio : 0;
  }

  /** Si va a pagar algo de anticipo */
  get pagaraAnticipo(): boolean {
    return this.anticipoObligatorio;
  }

  calcularRestante(): number {
    const precio = this.totalServicioFinal;
    return precio - this.montoAnticipo;
  }

  /** Actualiza el anticipo voluntario (input libre) */
  setAnticipoVoluntario(valor: number): void {
    const precio = this.totalServicioFinal;
    if (valor < 0) valor = 0;
    if (valor > precio) valor = precio;
    if (this.anticipoObligatorio && valor < this.montoAnticipoObligatorio) {
      valor = this.montoAnticipoObligatorio;
    }
    this.anticipoVoluntario.set(valor);
  }

  actualizarCodigoDescuento(valor: string): void {
    this.codigoDescuento.set((valor || '').toUpperCase().trim());
    this.errorPromocion.set('');
    this.mensajePromocion.set('');
  }

  aplicarCuponServicio(): void {
    const codigo = this.codigoDescuento();
    if (!codigo) {
      this.errorPromocion.set('Ingresa un código de descuento.');
      return;
    }
    const subtotal = this.precioBaseServicio;
    if (subtotal <= 0) {
      this.errorPromocion.set('No se pudo calcular el subtotal del servicio.');
      return;
    }
    this.validandoPromocion.set(true);
    this.errorPromocion.set('');
    this.mensajePromocion.set('');
    this.pedidoService.validarPromocion({
      codigo,
      subtotal,
      aplica_en_objetivo: 'servicios'
    }).subscribe({
      next: (res: any) => {
        this.validandoPromocion.set(false);
        if (res?.ok && res?.promocion) {
          const descuento = Number(res.descuento || 0);
          this.promoAplicada.set({
            codigo: String(res.promocion.codigo || codigo),
            nombre: String(res.promocion.nombre || ''),
            tipo_descuento: String(res.promocion.tipo_descuento || ''),
            valor_descuento: Number(res.promocion.valor_descuento || 0),
            descuento: Math.max(0, descuento),
          });
          if (!this.anticipoObligatorio && this.quierePagarAnticipo()) {
            this.setAnticipoVoluntario(this.anticipoVoluntario());
          }
          this.mensajePromocion.set(`Cupón aplicado. Descuento: $${descuento.toFixed(2)} MXN`);
        }
      },
      error: (err: any) => {
        this.validandoPromocion.set(false);
        this.promoAplicada.set(null);
        this.errorPromocion.set(err?.error?.error || 'No se pudo aplicar el cupón.');
      }
    });
  }

  quitarCuponServicio(): void {
    this.promoAplicada.set(null);
    this.codigoDescuento.set('');
    this.errorPromocion.set('');
    this.mensajePromocion.set('Cupón removido.');
  }

  seleccionarMetodoAnticipo(metodo: 'transferencia' | 'tarjeta'): void {
    this.metodoPagoAnticipo.set(metodo);
    this.clipError.set('');
    if (metodo === 'tarjeta') {
      this.prepararCheckoutTarjeta().catch((err) => {
        this.clipError.set(err instanceof Error ? err.message : 'No se pudo inicializar tarjeta.');
      });
    } else {
      this.clipCardMounted = false;
    }
  }

  /** Manejar selección de archivo de comprobante */
  onComprobanteSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      // Validar tipo y tamaño
      const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'];
      if (!validTypes.includes(file.type)) {
        this.errorCita.set('Solo se permiten imágenes (JPG, PNG, WEBP)');
        return;
      }
      if (file.size > 10 * 1024 * 1024) { // 10MB máximo
        this.errorCita.set('La imagen no debe superar 10MB');
        return;
      }
      this.errorCita.set('');
      this.comprobanteFile.set(file);
      // Crear preview
      const reader = new FileReader();
      reader.onload = (e) => {
        this.comprobantePreview.set(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  }

  /** Eliminar comprobante seleccionado */
  eliminarComprobante(): void {
    this.comprobanteFile.set(null);
    this.comprobantePreview.set('');
  }

  private async prepararCheckoutTarjeta(): Promise<void> {
    if (this.metodoPagoAnticipo() !== 'tarjeta') return;
    if (this.clipCardMounted) return;
    if (this.clipCargando()) return;
    this.clipCargando.set(true);
    this.clipError.set('');
    try {
      await this.cargarScriptClip();
      const cfg = await firstValueFrom(this.pedidoService.clipConfig());
      const key = String(cfg?.clip_api_key_public || '').trim();
      if (!key) throw new Error('No se encontró la API Key pública de Clip.');
      this.clipPublicKey = key;
      const win = window as any;
      if (!win.ClipSDK) throw new Error('No se pudo cargar clip-sdk.js');
      const container = document.getElementById('clip-cita-card');
      if (!container) throw new Error('No se encontró el formulario de tarjeta.');
      container.replaceChildren();
      this.clipSdkInstance = new win.ClipSDK(this.clipPublicKey);
      this.clipCard = this.clipSdkInstance.element.create('Card', { locale: 'es', theme: 'dark' });
      this.clipCard.mount('clip-cita-card');
      this.clipCardMounted = true;
      this.clipSdkListo = true;
    } catch (e: any) {
      this.clipError.set(e?.message || 'No se pudo inicializar pago con tarjeta.');
    } finally {
      this.clipCargando.set(false);
    }
  }

  private async cargarScriptClip(): Promise<void> {
    const win = window as any;
    if (win.ClipSDK) return;
    const scriptId = 'clip-sdk-js';
    if (document.getElementById(scriptId)) {
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 300));
      if (win.ClipSDK) return;
    }
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.id = scriptId;
      script.src = 'https://sdk.clip.mx/js/clip-sdk.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('No se pudo cargar SDK de Clip.'));
      document.head.appendChild(script);
    });
  }

  private async tokenizarTarjetaClip(): Promise<string> {
    await this.prepararCheckoutTarjeta();
    if (!this.clipCard) throw new Error('Formulario de tarjeta Clip no está listo.');
    this.clipTokenizando.set(true);
    this.clipError.set('');
    try {
      const tokenRes: any = await this.withTimeout(
        Promise.resolve(this.clipCard.cardToken()),
        30000,
        'Clip tardó demasiado en tokenizar la tarjeta. Verifica los datos de la tarjeta o intenta nuevamente.'
      );
      const tokenId = String(tokenRes?.id || '').trim();
      if (!tokenId) throw new Error('Clip no devolvió Card Token ID.');
      return tokenId;
    } finally {
      this.clipTokenizando.set(false);
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
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

  // ============================================
  // CONFIRMAR CITA (backend real)
  // ============================================

  async confirmarCita(): Promise<void> {
    if (!this.servicioSeleccionado() || !this.barberoSeleccionado() ||
        !this.fechaSeleccionada() || !this.horaSeleccionada()) {
      return;
    }

    const anticipo = this.montoAnticipo;
    const metodoAnticipo = this.metodoPagoAnticipo();

    if (anticipo > 0 && metodoAnticipo === 'transferencia' && !this.comprobanteFile()) {
      this.errorCita.set('Debes adjuntar el comprobante de tu transferencia.');
      return;
    }
    if (anticipo > 0 && metodoAnticipo === 'tarjeta' && !this.clipCardMounted) {
      this.errorCita.set('Primero completa los datos de tarjeta.');
      return;
    }

    this.creandoCita.set(true);
    this.errorCita.set('');
    this.exitoCita.set('');

    const servicio = this.servicioSeleccionado()!;
    const barbero = this.barberoSeleccionado()!;
    const fecha = this.fechaSeleccionada()!;
    const fechaStr = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}-${String(fecha.getDate()).padStart(2, '0')}`;
    const horaStr = this.horaSeleccionada()!;
    const user = this.authService.getCurrentUser();

    if (!user?.id) {
      this.errorCita.set('Debes iniciar sesión para agendar una cita.');
      this.creandoCita.set(false);
      return;
    }

    let comprobanteUrl = '';
    try {
      if (anticipo > 0 && metodoAnticipo === 'transferencia' && this.comprobanteFile()) {
        this.subiendoComprobante.set(true);
        const uploadRes: any = await firstValueFrom(
          this.authService.uploadComprobantePago(this.comprobanteFile()!, 'comprobantes_citas')
        );
        this.subiendoComprobante.set(false);
        comprobanteUrl = uploadRes?.url || uploadRes?.secure_url || '';
        if (!comprobanteUrl) {
          const uploadError = uploadRes?.error || 'No se pudo subir el comprobante de transferencia.';
          throw new Error(uploadError);
        }
      }

      const resCita: any = await firstValueFrom(this.adminService.createCita({
        barbero_id: Number(barbero.id),
        servicio_id: Number(servicio.id),
        fecha: fechaStr,
        hora: horaStr,
        comprobante_pago: comprobanteUrl,
        codigo_descuento: this.promoAplicada()?.codigo || '',
        notas: this.buildNotasComplementos()
      }));

      if (!resCita?.ok || !resCita?.id) {
        throw new Error('No se pudo crear la cita.');
      }

      if (resCita.requiere_anticipo && metodoAnticipo === 'tarjeta') {
        const tokenId = await this.tokenizarTarjetaClip();
        const clienteEmail = String(user.email || '').trim();
        const clientePhone = String((user as any)?.telefono || '').trim();
        const clipRes = await firstValueFrom(this.pedidoService.clipIntentarPago({
          tipo: 'cita',
          cita_id: Number(resCita.id),
          card_token_id: tokenId,
          cliente_email: clienteEmail || undefined,
          cliente_phone: clientePhone || undefined,
        }));
        const estadoPago = this.pedidoService.normalizarEstadoPago(clipRes?.estado_pago);
        if (!clipRes?.ok || estadoPago === 'rechazado' || estadoPago === 'inconsistente') {
          throw new Error('No fue posible confirmar el pago con Clip.');
        }
        if (clipRes.checkout_url) {
          this.redirigirAClipSeguro(clipRes.checkout_url);
          return;
        }
      }

      this.creandoCita.set(false);
      const msg = resCita.requiere_anticipo
        ? 'Cita creada. El estado del anticipo se confirmará desde el backend.'
        : '¡Cita agendada con éxito!';
      this.exitoCita.set(msg);
      setTimeout(() => {
        this.router.navigate(['/cliente/citas']);
      }, 1200);
    } catch (err: any) {
      this.subiendoComprobante.set(false);
      this.creandoCita.set(false);
      this.exitoCita.set('');
      this.errorCita.set('No fue posible crear la cita. Revisa los datos e intenta de nuevo.');
    }
  }

  private redirigirAClipSeguro(checkoutUrl: string): void {
    try {
      const url = new URL(checkoutUrl);
      if (url.protocol !== 'https:') throw new Error('Protocolo no permitido');
      window.location.assign(url.toString());
    } catch {
      throw new Error('El backend no devolvió una URL segura de pago.');
    }
  }
}
