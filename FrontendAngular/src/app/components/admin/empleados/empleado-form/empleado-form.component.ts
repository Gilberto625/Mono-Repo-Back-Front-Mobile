import { Component, inject, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../../shared/breadcrumb/breadcrumb.component';
import { AdminService, HorarioDiaConfig } from '../../../../services/admin.service';
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
const ROLES_EMPLEADO_PERMITIDOS = new Set(['admin', 'secretaria', 'barbero']);
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const IMAGE_NAME_REGEX = /\.(png|jpe?g|webp|gif|bmp|svg|heic|heif|avif)$/i;

@Component({
  selector: 'app-empleado-form',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './empleado-form.component.html',
  styleUrl: './empleado-form.component.css'
})
export class EmpleadoFormComponent implements OnInit {
  @Input() modal = false;
  @Output() guardado = new EventEmitter<void>();
  @Output() cancelado = new EventEmitter<void>();

  private adminService = inject(AdminService);
  private modalService = inject(ModalService);
  private router = inject(Router);

  get esSecretaria(): boolean {
    return this.router.url.startsWith('/secretaria');
  }

  get empleadosBase(): string {
    return this.esSecretaria ? '/secretaria/empleados' : '/admin/empleados';
  }

  get rolesPermitidos(): string[] {
    return this.esSecretaria ? ['barbero'] : ['admin', 'secretaria', 'barbero'];
  }

  guardando = false;
  fotoPreview: string | null = null;
  avatarUrlEnviar: string | null = null;
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

  ngOnInit(): void {
    const config$ = this.adminService.getConfiguracion().pipe(
      catchError(() =>
        this.adminService.getConfiguracionPublica().pipe(catchError(() => of(null)))
      )
    );

    forkJoin({
      sillas: this.adminService.getSillas().pipe(catchError(() => of({ ok: false, sillas: [] }))),
      config: config$,
    }).subscribe({
      next: ({ sillas, config }) => {
        if (sillas?.ok && Array.isArray(sillas.sillas) && sillas.sillas.length > 0) {
          this.sillasOpciones = sillas.sillas.map((s: { numero: string; nombre?: string; ocupada?: boolean; ocupada_por?: string; ocupada_por_empleado_id?: number | null }) => {
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
        } else {
          this.sillasOpciones = [];
          if (!sillas?.ok) {
            this.modalService.showError('No se pudo cargar la lista de sillas.');
          }
        }

        if (config) {
          this.aplicarHorariosNegocioDesdeConfig(config);
        } else {
          this.horariosNegocioCargados = false;
          this.modalService.showError('No se pudo cargar la configuración de horarios del negocio.');
        }
      },
    });
  }

  cargarHorariosNegocio(): void {
    this.adminService.getConfiguracion().subscribe({
      next: (res: any) => this.aplicarHorariosNegocioDesdeConfig(res),
      error: () => {
        this.adminService.getConfiguracionPublica().subscribe({
          next: (resPublica: any) => this.aplicarHorariosNegocioDesdeConfig(resPublica),
          error: () => {
            this.horariosNegocioCargados = false;
            this.modalService.showError('No se pudo cargar la configuración de horarios del negocio.');
          },
        });
      },
    });
  }

  cargarSillas(): void {
    this.adminService.getSillas().subscribe({
      next: (res) => {
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
          return;
        }
        this.sillasOpciones = [];
      },
      error: () => {
        this.sillasOpciones = [];
        this.modalService.showError('No se pudo cargar la lista de sillas.');
      },
    });
  }

  private aplicarHorariosNegocioDesdeConfig(res: any): void {
    const cfg = res?.configuracion ?? res ?? {};
    const horariosRaw = Array.isArray(cfg?.horarios_por_dia)
      ? cfg.horarios_por_dia
      : (Array.isArray(cfg?.horarios) ? cfg.horarios : []);
    const horarios = this.normalizarHorariosNegocio(horariosRaw);
    if (Array.isArray(horarios) && horarios.length >= 7) {
      this.horariosNegocio = horarios;
      this.horariosNegocioCargados = true;
      this.sincronizarHorariosConNegocio();
    }
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

  /** Ajusta los horarios por defecto del form para que coincidan con los del negocio */
  sincronizarHorariosConNegocio(): void {
    for (const dia of DIAS_SEMANA) {
      const negocio = this.horariosNegocio[dia.idx];
      if (!negocio) continue;
      const emp = this.form.horario[dia.key];

      if (!negocio.abierto) {
        // Si el negocio está cerrado, el empleado no trabaja
        emp.trabaja = false;
        emp.inicio = '';
        emp.fin = '';
      } else {
        // Ajustar inicio/fin a los del negocio
        emp.inicio = negocio.apertura || '09:00';
        emp.fin = negocio.cierre || '20:00';
      }
    }
  }

  form = {
    nombre: '',
    apellido: '',
    email: '',
    password: '',
    telefono: '',
    fecha_nacimiento: '' as string,
    rol: 'barbero' as string,
    especialidades: [] as string[],
    bio: '',
    silla_asignada: '',
    horario: DIAS_SEMANA.reduce((acc, d) => {
      const isSun = d.key === 'domingo';
      const isSat = d.key === 'sabado';
      acc[d.key] = {
        trabaja: !isSun,
        inicio: '09:00',
        fin: isSat ? '15:00' : '18:00',
        descanso: isSun ? '' : (isSat ? '-' : '13:00-14:00')
      };
      return acc;
    }, {} as Record<string, { trabaja: boolean; inicio: string; fin: string; descanso: string }>)
  };

  get esBarbero(): boolean {
    return this.form.rol === 'barbero';
  }

  /** Devuelve el horario del negocio para un día dado */
  getNegocioDia(diaKey: string): HorarioDiaConfig | null {
    const dia = DIAS_SEMANA.find(d => d.key === diaKey);
    if (!dia || !this.horariosNegocio[dia.idx]) return null;
    return this.horariosNegocio[dia.idx];
  }

  /** Devuelve true si el negocio está cerrado ese día */
  negocioCerrado(diaKey: string): boolean {
    const n = this.getNegocioDia(diaKey);
    return n ? !n.abierto : false;
  }

  /** Devuelve el rango permitido como texto (para mostrar al usuario) */
  getRangoNegocio(diaKey: string): string {
    const n = this.getNegocioDia(diaKey);
    if (!n || !n.abierto) return 'Cerrado';
    return `${n.apertura || '09:00'} - ${n.cierre || '20:00'}`;
  }

  /** Valida los horarios del empleado contra los del negocio. Devuelve lista de errores. */
  validarHorarios(): string[] {
    if (!this.horariosNegocioCargados) return [];
    const errores: string[] = [];

    for (const dia of DIAS_SEMANA) {
      const emp = this.form.horario[dia.key];
      const neg = this.horariosNegocio[dia.idx];
      if (!neg || !neg.abierto) {
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
      const apertura = neg.apertura || '09:00';
      const cierre = neg.cierre || '20:00';
      if (emp.inicio < apertura) {
        errores.push(`${dia.label}: La hora de inicio (${emp.inicio}) es antes de que abra el negocio (${apertura}).`);
      }
      if (emp.fin > cierre) {
        errores.push(`${dia.label}: La hora de fin (${emp.fin}) es después de que cierre el negocio (${cierre}).`);
      }
      if (emp.inicio >= emp.fin) {
        errores.push(`${dia.label}: La hora de inicio debe ser antes de la hora de fin.`);
      }
      const errorDescanso = this.validarDescansoDia(emp.inicio, emp.fin, emp.descanso || '');
      if (errorDescanso) {
        errores.push(`${dia.label}: ${errorDescanso}`);
      }
    }
    return errores;
  }

  /** Devuelve error de horario para un día específico (para mostrar inline) */
  getErrorHorarioDia(diaKey: string): string {
    if (!this.horariosNegocioCargados) return '';
    const dia = DIAS_SEMANA.find(d => d.key === diaKey);
    if (!dia) return '';
    const emp = this.form.horario[diaKey];
    const neg = this.horariosNegocio[dia.idx];
    if (!emp.trabaja) return '';
    if (!neg || !neg.abierto) {
      emp.trabaja = false;
      emp.inicio = '';
      emp.fin = '';
      emp.descanso = '';
      return '';
    }
    const apertura = neg.apertura || '09:00';
    const cierre = neg.cierre || '20:00';
    if (emp.inicio < apertura) return `No puede ser antes de ${apertura}`;
    if (emp.fin > cierre) return `No puede ser después de ${cierre}`;
    if (emp.inicio >= emp.fin) return 'Inicio debe ser antes del fin';
    const errorDescanso = this.validarDescansoDia(emp.inicio, emp.fin, emp.descanso || '');
    if (errorDescanso) return errorDescanso;
    return '';
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

  toggleEspecialidad(id: string): void {
    const i = this.form.especialidades.indexOf(id);
    if (i >= 0) this.form.especialidades.splice(i, 1);
    else this.form.especialidades.push(id);
  }

  tieneEspecialidad(id: string): boolean {
    return this.form.especialidades.includes(id);
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
      const avatarNormalizado = await this.normalizarImagenParaAvatar(file);
      this.fotoPreview = avatarNormalizado;
      this.avatarUrlEnviar = avatarNormalizado;
    } catch {
      this.modalService.showError('No se pudo procesar la imagen seleccionada.');
      input.value = '';
    }
  }

  guardar(): void {
    if (this.esSecretaria) {
      this.form.rol = 'barbero';
    }
    const nombre = (this.form.nombre || '').trim();
    const apellido = (this.form.apellido || '').trim();
    const email = (this.form.email || '').trim().toLowerCase();
    const telefonoRaw = (this.form.telefono || '').trim();
    const telefonoNumeros = telefonoRaw.replace(/\D+/g, '');
    const password = this.form.password || '';
    const bio = (this.form.bio || '').trim();
    const avatar = this.avatarUrlEnviar;

    if (!nombre || !apellido || !email) {
      this.modalService.showError('Nombre, apellido y correo son requeridos.');
      return;
    }
    if (!avatar) {
      this.modalService.showError('La foto de perfil es obligatoria para registrar al empleado.');
      return;
    }
    if (nombre.length < 2 || apellido.length < 2) {
      this.modalService.showError('Nombre y apellido deben tener al menos 2 caracteres.');
      return;
    }
    if (!EMAIL_REGEX.test(email)) {
      this.modalService.showError('Ingresa un correo electrónico válido.');
      return;
    }
    if (!password.trim()) {
      this.modalService.showError('La contraseña es requerida.');
      return;
    }
    if (password.length < 8) {
      this.modalService.showError('La contraseña debe tener al menos 8 caracteres.');
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
    if (!ROLES_EMPLEADO_PERMITIDOS.has(this.form.rol) || (this.esSecretaria && this.form.rol !== 'barbero')) {
      this.modalService.showError('En Empleados solo se permiten los roles: Administrador, Recepcionista y Barbero.');
      return;
    }
    if (this.esBarbero && this.form.especialidades.length === 0) {
      this.modalService.showError('Selecciona al menos una especialidad para el barbero.');
      return;
    }
    if (bio.length > 500) {
      this.modalService.showError('La biografía no debe exceder 500 caracteres.');
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

    this.guardando = true;
    const payload: Record<string, unknown> = {
      nombre,
      apellido,
      email,
      password,
      telefono: telefonoNumeros || undefined,
      fecha_nacimiento: this.form.fecha_nacimiento || undefined,
      rol: this.form.rol,
      especialidades: this.form.especialidades.length ? JSON.stringify(this.form.especialidades.map(id => ESPECIALIDADES_OPCIONES.find(o => o.id === id)?.label || id)) : '',
      bio: bio || undefined,
      silla_asignada: this.esBarbero ? (this.form.silla_asignada?.trim() || '') : '',
      horario_trabajo: JSON.stringify(this.form.horario)
    };

    const doCreate = (avatarUrl?: string) => {
      if (avatarUrl) payload['avatar_url'] = avatarUrl;
      this.adminService.crearEmpleado(payload).subscribe({
        next: (res) => {
          this.guardando = false;
          if (res?.ok) {
            this.modalService.showSuccess('Empleado registrado. Podrá iniciar sesión con su correo y contraseña con el rol asignado.');
            if (this.modal) {
              this.guardado.emit();
            } else {
              this.router.navigate([this.empleadosBase]);
            }
          } else {
            this.modalService.showError(res?.error || 'Error al guardar');
          }
        },
        error: (err) => {
          this.guardando = false;
          this.modalService.showError(err?.error?.error || 'Error al guardar empleado');
        }
      });
    };

    if (avatar && avatar.startsWith('data:')) {
      // Garantiza alta con foto sin depender de Cloudinary.
      doCreate(avatar);
    } else if (avatar && (avatar.startsWith('http://') || avatar.startsWith('https://'))) {
      doCreate(avatar);
    } else {
      doCreate();
    }
  }

  cancelar(): void {
    if (this.modal) {
      this.cancelado.emit();
    } else {
      this.router.navigate([this.empleadosBase]);
    }
  }

  esSillaDeshabilitada(numeroSilla: string): boolean {
    const silla = this.sillasOpciones.find(s => s.value === numeroSilla);
    return !!silla?.ocupada;
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
