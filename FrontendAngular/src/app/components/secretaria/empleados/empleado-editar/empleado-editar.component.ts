import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { CommonModule } from '@angular/common';
import { RouterModule, Router, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../../shared/breadcrumb/breadcrumb.component';
import { AdminService, Empleado, HorarioDiaConfig } from '../../../../services/admin.service';
import { ModalService } from '../../../../services/modal.service';

const DIAS_SEMANA = [
  { key: 'lunes', label: 'Lunes', idx: 0 },
  { key: 'martes', label: 'Martes', idx: 1 },
  { key: 'miercoles', label: 'Miércoles', idx: 2 },
  { key: 'jueves', label: 'Jueves', idx: 3 },
  { key: 'viernes', label: 'Viernes', idx: 4 },
  { key: 'sabado', label: 'Sábado', idx: 5 },
  { key: 'domingo', label: 'Domingo', idx: 6 }
];

const ESPECIALIDADES_OPCIONES = [
  { id: 'cortes_clasicos', label: 'Cortes clásicos' },
  { id: 'fade', label: 'Fade' },
  { id: 'barba', label: 'Barba' },
  { id: 'disenos', label: 'Diseños' },
  { id: 'coloracion', label: 'Coloración' },
  { id: 'tratamientos', label: 'Tratamientos' }
];
const ROLES_EMPLEADO_PERMITIDOS = new Set(['barbero']);
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const IMAGE_NAME_REGEX = /\.(png|jpe?g|webp|gif|bmp|svg|heic|heif|avif)$/i;

function parseHorarioDefault() {
  return DIAS_SEMANA.reduce((acc, d) => {
    const isSun = d.key === 'domingo';
    const isSat = d.key === 'sabado';
    acc[d.key] = {
      trabaja: !isSun,
      inicio: '09:00',
      fin: isSat ? '15:00' : '18:00',
      descanso: isSun ? '' : (isSat ? '-' : '13:00-14:00')
    };
    return acc;
  }, {} as Record<string, { trabaja: boolean; inicio: string; fin: string; descanso: string }>);
}

@Component({
  selector: 'app-empleado-editar',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './empleado-editar.component.html',
  styleUrl: './empleado-editar.component.css'
})
export class EmpleadoEditarComponent implements OnInit {
  private adminService = inject(AdminService);
  private modalService = inject(ModalService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private readonly navEmpleado = this.router.getCurrentNavigation()?.extras?.state?.['empleado'] as Empleado | undefined;

  id: number | null = null;
  loading = true;
  guardando = false;
  tabActivo = signal<'datos' | 'horario' | 'dias' | 'vacaciones'>('datos');
  diasSemana = DIAS_SEMANA;
  especialidadesOpciones = ESPECIALIDADES_OPCIONES;
  sillasOpciones: {
    value: string;
    label: string;
    ocupada: boolean;
    ocupadaPorEmpleadoId: number | null;
  }[] = [];

  /** Horarios del negocio por día (0=Lunes..6=Domingo) */
  horariosNegocio: HorarioDiaConfig[] = [];
  horariosNegocioCargados = false;

  form = {
    nombre: '',
    apellido: '',
    email: '',
    telefono: '',
    fecha_nacimiento: '' as string,
    rol: 'barbero' as string,
    estado: 'activo' as string,
    especialidades: [] as string[],
    bio: '',
    silla_asignada: '',
    horario: parseHorarioDefault(),
    diasLibres: [] as { fecha: string; motivo: string; estado: string }[],
    periodosVacaciones: [] as { fecha_solicitud: string; fecha_inicio: string; fecha_fin: string; estado: string }[]
  };

  nuevoDiaLibre = { fecha: '', motivo: '', estado: 'pendiente' as string };
  nuevoPeriodoVacaciones = { fecha_inicio: '', fecha_fin: '', estado: 'pendiente' as string };

  fotoPreview: string | null = null;

  subtitulo = computed(() => {
    const n = this.form.nombre || '';
    const a = this.form.apellido || '';
    const r = this.form.rol === 'barbero' ? 'Barbero' : this.form.rol === 'secretaria' ? 'Recepcionista' : 'Administrador';
    return `${n} ${a}`.trim() ? `${n} ${a} - ${r}` : 'Cargando...';
  });

  get esBarbero(): boolean {
    return this.form.rol === 'barbero';
  }

  getRolLabel(rol: string): string {
    const labels: Record<string, string> = {
      admin: 'Administrador',
      barbero: 'Barbero',
      secretaria: 'Recepcionista'
    };
    return labels[rol] || rol;
  }

  toggleEspecialidad(id: string): void {
    const i = this.form.especialidades.indexOf(id);
    if (i >= 0) this.form.especialidades.splice(i, 1);
    else this.form.especialidades.push(id);
  }

  tieneEspecialidad(id: string): boolean {
    return this.form.especialidades.includes(id);
  }

  setTab(tab: 'datos' | 'horario' | 'dias' | 'vacaciones'): void {
    this.tabActivo.set(tab);
  }

  agregarDiaLibre(): void {
    if (!this.nuevoDiaLibre.fecha?.trim()) {
      this.modalService.showError('Indica la fecha del día libre');
      return;
    }
    const fecha = this.nuevoDiaLibre.fecha.slice(0, 10);
    if (!this.esFechaIsoValida(fecha)) {
      this.modalService.showError('La fecha del día libre no es válida.');
      return;
    }
    const repetido = (this.form.diasLibres || []).some(d => (d.fecha || '').slice(0, 10) === fecha);
    if (repetido) {
      this.modalService.showError('Ya existe un día libre registrado para esa fecha.');
      return;
    }
    this.form.diasLibres = this.form.diasLibres || [];
    this.form.diasLibres.push({
      fecha,
      motivo: this.nuevoDiaLibre.motivo?.trim() || 'Día libre',
      estado: this.nuevoDiaLibre.estado || 'pendiente'
    });
    this.nuevoDiaLibre = { fecha: '', motivo: '', estado: 'pendiente' };
  }

  eliminarDiaLibre(index: number): void {
    this.form.diasLibres = this.form.diasLibres || [];
    this.form.diasLibres.splice(index, 1);
  }

  formatFechaDiaLibre(fecha: string): string {
    if (!fecha) return '-';
    const d = new Date(fecha + 'T12:00:00');
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  getEstadoDiaLibreLabel(estado: string): string {
    const labels: Record<string, string> = { pendiente: 'Pendiente', aprobado: 'Aprobado', rechazado: 'Rechazado' };
    return labels[estado] || estado;
  }

  agregarPeriodoVacaciones(): void {
    if (!this.nuevoPeriodoVacaciones.fecha_inicio?.trim() || !this.nuevoPeriodoVacaciones.fecha_fin?.trim()) {
      this.modalService.showError('Indica fecha inicial y final de vacaciones');
      return;
    }
    const hoy = new Date().toISOString().slice(0, 10);
    const inicio = this.nuevoPeriodoVacaciones.fecha_inicio.slice(0, 10);
    const fin = this.nuevoPeriodoVacaciones.fecha_fin.slice(0, 10);
    if (!this.esFechaIsoValida(inicio) || !this.esFechaIsoValida(fin)) {
      this.modalService.showError('Las fechas del periodo de vacaciones no son válidas.');
      return;
    }
    if (fin < inicio) {
      this.modalService.showError('La fecha final debe ser posterior a la inicial');
      return;
    }
    const traslape = (this.form.periodosVacaciones || []).some((p) => {
      const pi = (p.fecha_inicio || '').slice(0, 10);
      const pf = (p.fecha_fin || '').slice(0, 10);
      if (!pi || !pf) return false;
      return !(fin < pi || inicio > pf);
    });
    if (traslape) {
      this.modalService.showError('El periodo se traslapa con otro ya registrado.');
      return;
    }
    this.form.periodosVacaciones = this.form.periodosVacaciones || [];
    this.form.periodosVacaciones.push({
      fecha_solicitud: hoy,
      fecha_inicio: inicio,
      fecha_fin: fin,
      estado: this.nuevoPeriodoVacaciones.estado || 'pendiente'
    });
    this.nuevoPeriodoVacaciones = { fecha_inicio: '', fecha_fin: '', estado: 'pendiente' };
  }

  eliminarPeriodoVacaciones(index: number): void {
    this.form.periodosVacaciones = this.form.periodosVacaciones || [];
    this.form.periodosVacaciones.splice(index, 1);
  }

  formatFechaVacaciones(fecha: string): string {
    if (!fecha) return '-';
    const d = new Date(fecha + 'T12:00:00');
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  getEstadoVacacionesLabel(estado: string): string {
    const normalized = this.normalizarEstadoVacacionesFrontend(estado);
    const labels: Record<string, string> = { pendiente: 'Pendiente', aprobado: 'Aprobado', rechazado: 'Rechazado' };
    return labels[normalized] || normalized;
  }

  private esFechaIsoValida(fecha: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return false;
    const d = new Date(`${fecha}T00:00:00`);
    if (Number.isNaN(d.getTime())) return false;
    return d.toISOString().slice(0, 10) === fecha;
  }

  private normalizarEstadoVacacionesFrontend(estado: string): 'pendiente' | 'aprobado' | 'rechazado' {
    const e = (estado || '').trim().toLowerCase();
    if (e === 'aprobada' || e === 'aprobado') return 'aprobado';
    if (e === 'rechazada' || e === 'rechazado') return 'rechazado';
    return 'pendiente';
  }

  /** Devuelve el horario del negocio para un día dado */
  getNegocioDia(diaKey: string): HorarioDiaConfig | null {
    const dia = DIAS_SEMANA.find(d => d.key === diaKey);
    if (!dia || !this.horariosNegocio[dia.idx]) return null;
    return this.horariosNegocio[dia.idx];
  }

  negocioCerrado(diaKey: string): boolean {
    const n = this.getNegocioDia(diaKey);
    return n ? !n.abierto : false;
  }

  getRangoNegocio(diaKey: string): string {
    const n = this.getNegocioDia(diaKey);
    if (!n || !n.abierto) return 'Cerrado';
    return `${n.apertura || '09:00'} - ${n.cierre || '20:00'}`;
  }

  validarHorarios(): string[] {
    const errores: string[] = [];
    for (const dia of DIAS_SEMANA) {
      const emp = this.form.horario[dia.key];
      if (!emp) continue;
      const neg = this.horariosNegocio[dia.idx];
      if (this.horariosNegocioCargados && (!neg || !neg.abierto)) {
        // Regla de negocio: si el local está cerrado, ese día no puede asignarse.
        emp.trabaja = false;
        emp.inicio = '';
        emp.fin = '';
        emp.descanso = '';
        continue;
      }
      if (!emp.trabaja) {
        continue;
      }
      if (!emp.inicio || !emp.fin) {
        errores.push(`${dia.label}: Completa hora de inicio y fin.`);
        continue;
      }
      if (emp.inicio >= emp.fin) {
        errores.push(`${dia.label}: Hora de inicio debe ser antes de la hora de fin.`);
      }
      const errorDescanso = this.validarDescansoDia(emp.inicio, emp.fin, emp.descanso || '');
      if (errorDescanso) {
        errores.push(`${dia.label}: ${errorDescanso}`);
      }
      if (this.horariosNegocioCargados && neg?.abierto) {
        const apertura = neg.apertura || '09:00';
        const cierre = neg.cierre || '20:00';
        if (emp.inicio < apertura) {
          errores.push(`${dia.label}: Inicio (${emp.inicio}) es antes de apertura (${apertura}).`);
        }
        if (emp.fin > cierre) {
          errores.push(`${dia.label}: Fin (${emp.fin}) es después de cierre (${cierre}).`);
        }
      }
    }
    return errores;
  }

  getErrorHorarioDia(diaKey: string): string {
    const dia = DIAS_SEMANA.find(d => d.key === diaKey);
    if (!dia) return '';
    const emp = this.form.horario[diaKey];
    if (!emp) return '';
    const neg = this.horariosNegocio[dia.idx];
    if (!emp.trabaja) return '';
    if (this.horariosNegocioCargados && (!neg || !neg.abierto)) {
      emp.trabaja = false;
      emp.inicio = '';
      emp.fin = '';
      emp.descanso = '';
      return '';
    }
    if (!emp.inicio || !emp.fin) return 'Completa hora de inicio y fin';
    if (emp.inicio >= emp.fin) return 'Inicio debe ser antes del fin';
    const errorDescanso = this.validarDescansoDia(emp.inicio, emp.fin, emp.descanso || '');
    if (errorDescanso) return errorDescanso;
    if (this.horariosNegocioCargados && neg?.abierto) {
      const apertura = neg.apertura || '09:00';
      const cierre = neg.cierre || '20:00';
      if (emp.inicio < apertura) return `No puede ser antes de ${apertura}`;
      if (emp.fin > cierre) return `No puede ser después de ${cierre}`;
    }
    return '';
  }

  onCambioTrabajaDia(diaKey: string): void {
    const dia = this.form.horario[diaKey];
    if (!dia || dia.trabaja) return;
    dia.inicio = '';
    dia.fin = '';
    dia.descanso = '';
  }

  private validarDescansoDia(inicioJornada: string, finJornada: string, descansoRaw: string): string {
    const descanso = (descansoRaw || '').trim();
    if (!descanso || descanso === '-') return '';
    const m = descanso.match(/^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/);
    if (!m) {
      return 'Descanso inválido. Usa formato HH:mm-HH:mm (ejemplo: 13:00-14:00).';
    }
    const inicioDescanso = `${m[1]}:${m[2]}`;
    const finDescanso = `${m[3]}:${m[4]}`;
    if (inicioDescanso >= finDescanso) {
      return 'El descanso debe iniciar antes de terminar.';
    }
    if (inicioDescanso < inicioJornada || finDescanso > finJornada) {
      return 'El descanso debe estar dentro del horario laboral del empleado.';
    }
    return '';
  }

  private aplicarConfigHorariosNegocio(res: any): void {
    const cfg = res?.configuracion ?? res ?? {};
    const horariosRaw = Array.isArray(cfg?.horarios_por_dia)
      ? cfg.horarios_por_dia
      : (Array.isArray(cfg?.horarios) ? cfg.horarios : []);
    const horarios = this.normalizarHorariosNegocio(horariosRaw);
    if (Array.isArray(horarios) && horarios.length >= 7) {
      this.horariosNegocio = horarios;
      this.horariosNegocioCargados = true;
    }
  }

  cargarHorariosNegocio(): void {
    this.adminService.getConfiguracionPublica().subscribe({
      next: (resPublica: any) => this.aplicarConfigHorariosNegocio(resPublica),
      error: () => {
        this.adminService.getConfiguracion().subscribe({
          next: (res: any) => this.aplicarConfigHorariosNegocio(res),
        });
      },
    });
  }

  private normalizarHorariosNegocio(horariosRaw: any[]): HorarioDiaConfig[] {
    const porDia = new Map<number, any>();
    for (const h of horariosRaw || []) {
      const idxRaw = h?.dia_semana;
      const idx = Number.isInteger(idxRaw) ? idxRaw : Number.parseInt(String(idxRaw), 10);
      if (!Number.isNaN(idx) && idx >= 0 && idx <= 6) {
        porDia.set(idx, h);
      }
    }

    return DIAS_SEMANA.map((_, i) => {
      const h = porDia.get(i) ?? {};
      return {
        abierto: !!h?.abierto,
        apertura: (h?.apertura ?? h?.hora_apertura ?? '').toString().slice(0, 5),
        cierre: (h?.cierre ?? h?.hora_cierre ?? '').toString().slice(0, 5),
      };
    });
  }

  ngOnInit(): void {
    const idParam = this.route.snapshot.paramMap.get('id');
    if (!idParam) {
      this.loading = false;
      this.modalService.showError('ID de empleado no válido');
      this.router.navigate(['/secretaria/empleados']);
      return;
    }
    this.id = +idParam;

    const desdeNav = this.navEmpleado && this.navEmpleado.id === this.id ? this.navEmpleado : null;
    const desdeCache = this.adminService.getEmpleadoEdicionBootstrap(this.id);
    const instant = desdeNav ?? desdeCache;
    if (instant) {
      this.rellenarForm(instant);
      this.loading = false;
    }

    const configHorarios$ = this.adminService.getConfiguracionPublica().pipe(
      catchError(() => this.adminService.getConfiguracion())
    );

    forkJoin({
      sillas: this.adminService.getSillas().pipe(catchError(() => of({ ok: false }))),
      config: configHorarios$.pipe(catchError(() => of({}))),
    }).subscribe({
      next: ({ sillas, config }) => {
        this.aplicarSillasDesdeResponse(sillas);
        this.aplicarConfigHorariosNegocio(config);
      },
    });

    this.adminService.getEmpleado(this.id).subscribe({
      next: (res) => {
        if (res?.ok && res.empleado) {
          this.rellenarForm(res.empleado);
        } else if (!instant) {
          this.modalService.showError('Empleado no encontrado');
          this.router.navigate(['/secretaria/empleados']);
        }
        this.loading = false;
      },
      error: () => {
        if (!instant) {
          this.modalService.showError('Error al cargar empleado');
          this.router.navigate(['/secretaria/empleados']);
        }
        this.loading = false;
      },
    });
  }

  private aplicarSillasDesdeResponse(res: any): void {
    if (res?.ok && Array.isArray(res.sillas) && res.sillas.length > 0) {
      this.sillasOpciones = res.sillas.map((s: { numero: string; nombre?: string; ocupada?: boolean; ocupada_por?: string; ocupada_por_empleado_id?: number | null }) => {
        const base = s.nombre || `Silla ${s.numero}`;
        const ocupada = !!s.ocupada;
        const ocupadaPor = (s.ocupada_por || '').trim();
        return {
          value: s.numero,
          label: ocupada && ocupadaPor ? `${base} (ocupada por ${ocupadaPor})` : base,
          ocupada,
          ocupadaPorEmpleadoId: s.ocupada_por_empleado_id ?? null,
        };
      });
    }
  }

  cargarSillas(): void {
    this.adminService.getSillas().subscribe({
      next: (res) => this.aplicarSillasDesdeResponse(res),
    });
  }

  private rellenarForm(e: Empleado): void {
    if (String(e.rol || '').toLowerCase() !== 'barbero') {
      this.modalService.showError('Secretaría solo puede editar empleados con rol barbero.');
      this.router.navigate(['/secretaria/empleados']);
      return;
    }
    this.form.nombre = e.nombre || '';
    this.form.apellido = e.apellido || '';
    this.form.email = e.email || '';
    this.form.telefono = e.telefono || '';
    this.form.fecha_nacimiento = e.fecha_nacimiento ? e.fecha_nacimiento.slice(0, 10) : '';
    this.form.rol = 'barbero';
    this.form.estado = e.en_vacaciones ? 'vacaciones' : e.activo ? 'activo' : 'inactivo';
    this.form.bio = e.bio || '';
    this.form.silla_asignada = e.silla_asignada || '';
    if (e.avatar_url) this.fotoPreview = e.avatar_url;

    const esp = e.especialidades;
    if (esp) {
      try {
        const arr = typeof esp === 'string' && esp.startsWith('[') ? JSON.parse(esp) : esp.split(',').map((s: string) => s.trim()).filter(Boolean);
        this.form.especialidades = ESPECIALIDADES_OPCIONES.filter(o => arr.includes(o.label)).map(o => o.id);
      } catch {
        this.form.especialidades = [];
      }
    }

    if (e.horario_trabajo) {
      try {
        const h = typeof e.horario_trabajo === 'string' ? JSON.parse(e.horario_trabajo) : e.horario_trabajo;
        if (h && typeof h === 'object') {
          const def = parseHorarioDefault();
          for (const d of DIAS_SEMANA) {
            if (h[d.key] && typeof h[d.key] === 'object') {
              this.form.horario[d.key] = {
                trabaja: !!h[d.key].trabaja,
                inicio: h[d.key].inicio || def[d.key].inicio,
                fin: h[d.key].fin || def[d.key].fin,
                descanso: h[d.key].descanso ?? def[d.key].descanso
              };
            }
          }
        }
      } catch {
        // keep default
      }
    }

    if (e.dias_libres) {
      try {
        const arr = typeof e.dias_libres === 'string' ? JSON.parse(e.dias_libres) : e.dias_libres;
        this.form.diasLibres = Array.isArray(arr) ? arr.map((item: { fecha?: string; motivo?: string; estado?: string }) => ({
          fecha: item.fecha ? String(item.fecha).slice(0, 10) : '',
          motivo: item.motivo || '',
          estado: item.estado || 'pendiente'
        })) : [];
      } catch {
        this.form.diasLibres = [];
      }
    } else {
      this.form.diasLibres = [];
    }

    const pv = (e as { periodos_vacaciones?: string | unknown[] }).periodos_vacaciones;
    if (pv != null && pv !== '') {
      try {
        const arr = typeof pv === 'string' ? JSON.parse(pv) : pv;
        this.form.periodosVacaciones = Array.isArray(arr) ? arr.map((item: { fecha_solicitud?: string; fecha_inicio?: string; fecha_fin?: string; estado?: string }) => ({
          fecha_solicitud: item.fecha_solicitud ? String(item.fecha_solicitud).slice(0, 10) : '',
          fecha_inicio: item.fecha_inicio ? String(item.fecha_inicio).slice(0, 10) : '',
          fecha_fin: item.fecha_fin ? String(item.fecha_fin).slice(0, 10) : '',
          estado: this.normalizarEstadoVacacionesFrontend(item.estado || 'pendiente')
        })) : [];
      } catch {
        this.form.periodosVacaciones = [];
      }
    } else {
      this.form.periodosVacaciones = [];
    }
  }

  async onFotoChange(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const esImagenPorTipo = (file.type || '').startsWith('image/');
    const esImagenPorNombre = IMAGE_NAME_REGEX.test(file.name || '');
    if (!esImagenPorTipo && !esImagenPorNombre) {
      this.modalService.showError('La foto debe ser un archivo de imagen.');
      input.value = '';
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      this.modalService.showError('La foto no debe superar 15 MB.');
      input.value = '';
      return;
    }
    try {
      this.fotoPreview = await this.normalizarImagenParaAvatar(file);
    } catch {
      this.modalService.showError('No se pudo procesar la imagen seleccionada.');
      input.value = '';
    }
  }

  guardar(): void {
    this.form.rol = 'barbero';
    const nombre = (this.form.nombre || '').trim();
    const apellido = (this.form.apellido || '').trim();
    const email = (this.form.email || '').trim().toLowerCase();
    const telefonoRaw = (this.form.telefono || '').trim();
    const telefonoNumeros = telefonoRaw.replace(/\D+/g, '');
    const bio = (this.form.bio || '').trim();

    if (!this.id || !nombre || !apellido || !email) {
      this.modalService.showError('Nombre, apellido y correo son requeridos.');
      return;
    }
    if (nombre.length < 2 || apellido.length < 2) {
      this.modalService.showError('Nombre y apellido deben tener al menos 2 caracteres.');
      return;
    }
    if (!EMAIL_REGEX.test(email)) {
      this.modalService.showError('Correo electrónico inválido.');
      return;
    }
    if (!telefonoNumeros) {
      this.modalService.showError('El teléfono es requerido.');
      return;
    }
    if (telefonoNumeros.length < 10 || telefonoNumeros.length > 15) {
      this.modalService.showError('El teléfono debe contener entre 10 y 15 dígitos.');
      return;
    }
    if (this.form.fecha_nacimiento) {
      const hoy = new Date().toISOString().slice(0, 10);
      if (!this.esFechaIsoValida(this.form.fecha_nacimiento)) {
        this.modalService.showError('La fecha de nacimiento no es válida. Usa formato YYYY-MM-DD.');
        return;
      }
      if (this.form.fecha_nacimiento > hoy) {
        this.modalService.showError('La fecha de nacimiento no puede ser futura.');
        return;
      }
      const nacimiento = new Date(`${this.form.fecha_nacimiento}T00:00:00`);
      const mayoria = new Date();
      mayoria.setFullYear(mayoria.getFullYear() - 16);
      if (nacimiento > mayoria) {
        this.modalService.showError('El empleado debe tener al menos 16 años.');
        return;
      }
    }
    if (bio.length > 500) {
      this.modalService.showError('La biografía no debe exceder 500 caracteres.');
      return;
    }
    if (!ROLES_EMPLEADO_PERMITIDOS.has(this.form.rol)) {
      this.modalService.showError('Secretaría solo puede modificar empleados con rol barbero.');
      return;
    }
    if (this.esBarbero && this.form.especialidades.length === 0) {
      this.modalService.showError('Selecciona al menos una especialidad para el barbero.');
      return;
    }
    if (this.esBarbero && this.form.silla_asignada && this.esSillaDeshabilitada(this.form.silla_asignada)) {
      this.modalService.showError('La silla seleccionada ya está ocupada por otro empleado.');
      return;
    }

    // Validar horarios contra negocio
    const erroresHorario = this.validarHorarios();
    if (erroresHorario.length > 0) {
      this.modalService.showError('Errores en horario:\n' + erroresHorario.join('\n'));
      return;
    }

    const activo = this.form.estado !== 'inactivo';
    const en_vacaciones = this.form.estado === 'vacaciones';
    const payload: Record<string, unknown> = {
      nombre,
      apellido,
      telefono: telefonoNumeros || undefined,
      fecha_nacimiento: this.form.fecha_nacimiento || undefined,
      rol: this.form.rol,
      activo,
      en_vacaciones,
      especialidades: this.form.especialidades.length ? JSON.stringify(this.form.especialidades.map(id => ESPECIALIDADES_OPCIONES.find(o => o.id === id)?.label || id)) : '',
      bio: bio || undefined,
      silla_asignada: this.esBarbero ? (this.form.silla_asignada?.trim() || '') : '',
      horario_trabajo: JSON.stringify(this.form.horario),
      dias_libres: (this.form.diasLibres && this.form.diasLibres.length) ? JSON.stringify(this.form.diasLibres) : '',
      periodos_vacaciones: Array.isArray(this.form.periodosVacaciones) && this.form.periodosVacaciones.length > 0
        ? JSON.stringify(this.form.periodosVacaciones)
        : '[]'
    };

    const doUpdate = (avatarUrl?: string) => {
      const p = { ...payload };
      if (avatarUrl !== undefined) p['avatar_url'] = avatarUrl;
      this.adminService.actualizarEmpleado(this.id!, p).subscribe({
        next: (res) => {
          this.guardando = false;
          if (res?.ok) {
            this.modalService.showSuccess('Cambios guardados correctamente');
            this.router.navigate(['/secretaria/empleados']);
          } else {
            this.modalService.showError(res?.error || 'Error al guardar');
          }
        },
        error: (err) => {
          this.guardando = false;
          this.modalService.showError(err?.error?.error || 'Error al guardar');
        }
      });
    };

    this.guardando = true;
    if (this.fotoPreview && this.fotoPreview.startsWith('data:')) {
      doUpdate(this.fotoPreview as string);
    } else if (this.fotoPreview && (this.fotoPreview.startsWith('http://') || this.fotoPreview.startsWith('https://'))) {
      doUpdate(this.fotoPreview);
    } else {
      doUpdate();
    }
  }

  cancelar(): void {
    this.router.navigate(['/secretaria/empleados']);
  }

  esSillaDeshabilitada(numeroSilla: string): boolean {
    const silla = this.sillasOpciones.find(s => s.value === numeroSilla);
    if (!silla?.ocupada) return false;
    if (this.id != null && silla.ocupadaPorEmpleadoId != null) {
      return silla.ocupadaPorEmpleadoId !== this.id;
    }
    return numeroSilla !== this.form.silla_asignada;
  }

  desactivarEmpleado(): void {
    if (!this.id) return;
    if (!confirm('¿Desactivar a este empleado? No podrá iniciar sesión hasta que lo reactives.')) return;
    this.adminService.actualizarEmpleado(this.id, { activo: false }).subscribe({
      next: () => {
        this.modalService.showSuccess('Empleado desactivado');
        this.router.navigate(['/secretaria/empleados']);
      },
      error: () => this.modalService.showError('Error al desactivar')
    });
  }

  private async normalizarImagenParaAvatar(file: File): Promise<string> {
    const dataUrl = await this.leerArchivoComoDataUrl(file);
    try {
      const img = await this.cargarImagen(dataUrl);
      const lado = Math.min(img.width, img.height);
      let sx = Math.floor((img.width - lado) / 2);
      let sy = Math.floor((img.height - lado) / 2);
      // Para fotos verticales (común 3:4), prioriza zona superior para no cortar rostro.
      if (img.height > img.width) {
        sy = Math.max(0, Math.floor((img.height - lado) * 0.22));
      }
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 512;
      const ctx = canvas.getContext('2d');
      if (!ctx) return dataUrl;
      ctx.drawImage(img, sx, sy, lado, lado, 0, 0, 512, 512);
      return canvas.toDataURL('image/jpeg', 0.9);
    } catch {
      return dataUrl;
    }
  }

  private leerArchivoComoDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  private cargarImagen(dataUrl: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('No se pudo cargar la imagen'));
      img.src = dataUrl;
    });
  }
}
