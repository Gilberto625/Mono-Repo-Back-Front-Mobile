import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SidebarComponent } from '../../shared/sidebar/sidebar.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb/breadcrumb.component';
import { AdminService, Configuracion } from '../../../services/admin.service';
import { ModalService } from '../../../services/modal.service';
import { LogoService } from '../../../services/logo.service';

export interface HorarioDia {
  dia: string;
  abierto: boolean;
  apertura: string;
  cierre: string;
}

export interface SillaConfig {
  id: number;
  numero: string;
  nombre: string;
  activa: boolean;
}

const DIAS_SEMANA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

@Component({
  selector: 'app-configuracion',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, SidebarComponent, BreadcrumbComponent],
  templateUrl: './configuracion.component.html',
  styleUrl: './configuracion.component.css'
})
export class ConfiguracionComponent implements OnInit {
  private readonly adminService = inject(AdminService);
  private readonly modalService = inject(ModalService);
  private readonly logoService = inject(LogoService);

  tabActivo: 'general' | 'horarios' | 'sillas' | 'pagos' | 'envios' | 'politicas' | 'redes' | 'logo' = 'general';
  guardando = false;
  /** True mientras se carga la configuración desde la API. */
  cargandoConfig = false;

  // Logo
  logoTipo: 'texto' | 'imagen' = 'texto';
  logoTexto = 'Stylo';
  logoTextoAcento = 'Barber';
  logoUrl = '';
  subiendoLogo = false;
  logoPreview = '';

  /** Horarios por día (tabla en tab Horarios). */
  horariosPorDia: HorarioDia[] = [];
  /** Sillas para tab Sillas (desde API). */
  sillas: SillaConfig[] = [];
  loadingSillas = false;
  costosEnvio = {
    recoger_local: 0,
    moto_mandado: 45,
    paqueteria: 150
  };
  pagoEfectivoActivo = true;
  pagoTarjetaActivo = false;
  pagoTransferenciaActivo = true;
  clipHabilitado = false;
  clipUrl = '';
  clipApiKeyPrueba = '';
  clipApiSecretPrueba = '';
  clipAuthToken = '';
  clipApiKeyPruebaMasked = '';
  clipApiSecretPruebaConfigurada = false;
  clipAuthTokenConfigurado = false;
  paqueteriasDisponibles: string[] = ['DHL', 'Estafeta', 'FedEx', 'Paquetexpress'];
  paqueteriasTexto = 'DHL, Estafeta, FedEx, Paquetexpress';

  /** Modal 2FA para actualizar credenciales Clip */
  showClip2FAModal = false;
  clip2FACodigo = '';
  clip2FATempToken = '';
  pendingConfigPayload: unknown = null;
  enviandoClip2FA = false;


  config: Configuracion = {
    nombre_negocio: 'Stylo Barber',
    direccion: '',
    telefono: '',
    email_contacto: '',
    horario_apertura: '09:00',
    horario_cierre: '20:00',
    porcentaje_anticipo: 30,
    banco_nombre: '',
    banco_cuenta: '',
    banco_titular: '',
    tiempo_espera_maximo: 10,
    citas_penalizacion: 10,
    facebook_url: '',
    instagram_url: '',
    x_url: '',
    tiktok_url: '',
    whatsapp_url: '',
    google_maps_url: '',
    apple_maps_url: ''
  };

  ngOnInit(): void {
    this.inicializarHorariosPorDia();
    this.cargarConfiguracion();
  }

  private inicializarHorariosPorDia(): void {
    this.horariosPorDia = DIAS_SEMANA.map((dia, i) => ({
      dia,
      abierto: i < 6,
      apertura: '09:00',
      cierre: i === 4 ? '21:00' : i === 5 ? '18:00' : '20:00'
    }));
  }

  cargarConfiguracion(): void {
    this.cargandoConfig = true;
    this.adminService.getConfiguracion().subscribe({
      next: (response) => {
        this.cargandoConfig = false;
        const c = response?.configuracion ?? response;
        if (c) {
          const horariosApi: any[] = Array.isArray(c.horarios_por_dia)
            ? c.horarios_por_dia
            : (Array.isArray(c.horarios) ? c.horarios : []);
          this.config = {
            ...this.config,
            nombre_negocio: c.nombre_negocio ?? this.config.nombre_negocio,
            direccion: c.direccion ?? c.direccion_texto ?? this.config.direccion,
            telefono: c.telefono ?? this.config.telefono,
            email_contacto: c.email_contacto ?? this.config.email_contacto,
            horario_apertura: this.normalizarHora(c.horario_apertura) ?? this.config.horario_apertura,
            horario_cierre: this.normalizarHora(c.horario_cierre) ?? this.config.horario_cierre,
            porcentaje_anticipo: c.porcentaje_anticipo ?? this.config.porcentaje_anticipo,
            banco_nombre: c.banco_nombre ?? this.config.banco_nombre,
            banco_cuenta: c.banco_cuenta ?? this.config.banco_cuenta,
            banco_titular: c.banco_titular ?? this.config.banco_titular,
            tiempo_espera_maximo: c.tiempo_espera_maximo ?? this.config.tiempo_espera_maximo,
            citas_penalizacion: c.citas_penalizacion ?? this.config.citas_penalizacion,
            facebook_url: c.facebook_url ?? '',
            instagram_url: c.instagram_url ?? '',
            x_url: c.x_url ?? '',
            tiktok_url: c.tiktok_url ?? '',
            whatsapp_url: c.whatsapp_url ?? '',
            google_maps_url: c.google_maps_url ?? '',
            apple_maps_url: c.apple_maps_url ?? ''
          };
          this.costosEnvio = {
            recoger_local: this.toCosto(c.costos_envio?.recoger_local, 0),
            moto_mandado: this.toCosto(c.costos_envio?.moto_mandado, 45),
            paqueteria: this.toCosto(c.costos_envio?.paqueteria, 150)
          };
          this.pagoEfectivoActivo = c.pago_efectivo_activo ?? true;
          this.pagoTarjetaActivo = c.pago_tarjeta_activo ?? false;
          this.pagoTransferenciaActivo = c.pago_transferencia_activo ?? true;
          this.clipHabilitado = c.clip_habilitado ?? this.pagoTarjetaActivo;
          this.clipUrl = '';
          this.clipApiKeyPruebaMasked = (c.clip_api_key_masked ?? c.clip_api_key_prueba_masked ?? '').toString().trim();
          this.clipApiSecretPruebaConfigurada = !!(c.clip_api_secret_configurada ?? c.clip_api_secret_prueba_configurada);
          this.clipAuthTokenConfigurado = !!(c.clip_auth_token_configurada);
          this.clipApiKeyPrueba = '';
          this.clipApiSecretPrueba = '';
          this.clipAuthToken = '';
          this.paqueteriasDisponibles = Array.isArray(c.paqueterias_disponibles) && c.paqueterias_disponibles.length
            ? c.paqueterias_disponibles
            : ['DHL', 'Estafeta', 'FedEx', 'Paquetexpress'];
          this.paqueteriasTexto = this.paqueteriasDisponibles.join(', ');
          // Cargar config de logo
          this.logoTipo = c.logo_tipo || 'texto';
          this.logoTexto = c.logo_texto ?? c.logo_texto_parte1 ?? 'Stylo';
          this.logoTextoAcento = c.logo_texto_acento ?? c.logo_texto_parte2 ?? 'Barber';
          this.logoUrl = c.logo_url || '';
          this.logoPreview = this.logoUrl;
          if (horariosApi.length > 0) {
            const byDay = new Map<number, any>();
            horariosApi.forEach((item: any) => {
              const idxRaw = item?.dia_semana;
              const idx = Number.isInteger(idxRaw) ? idxRaw : Number.parseInt(String(idxRaw), 10);
              if (!Number.isNaN(idx)) {
                byDay.set(idx, item);
              }
            });
            this.horariosPorDia = DIAS_SEMANA.map((dia, i) => {
              const h = byDay.get(i) ?? {};
              return {
                dia,
                abierto: !!h?.abierto,
                apertura: this.normalizarHora(h?.apertura ?? h?.hora_apertura) || '09:00',
                cierre: this.normalizarHora(h?.cierre ?? h?.hora_cierre) || '20:00'
              };
            });
          } else {
            this.aplicarConfigAHorariosPorDia();
          }
        }
      },
      error: () => {
        this.cargandoConfig = false;
        this.modalService.showInfo('No se pudo cargar la configuración. Se muestran valores por defecto.');
      }
    });
  }

  /** Convierte "09:00:00" a "09:00" para inputs type="time". */
  private normalizarHora(val: string | undefined): string | undefined {
    if (val == null || val === '') return undefined;
    const s = String(val).trim();
    return s.length > 5 ? s.substring(0, 5) : s;
  }

  private toCosto(val: unknown, fallback: number): number {
    const parsed = Number(val);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Number(parsed.toFixed(2));
  }

  private parsePaqueteriasDesdeTexto(): string[] {
    const source = (this.paqueteriasTexto || '').trim();
    if (!source) return [];
    const tokens = source
      .split(/[\n,;]+/g)
      .map(t => t.trim())
      .filter(Boolean);
    const out: string[] = [];
    for (const token of tokens) {
      if (!out.includes(token)) out.push(token);
      if (out.length >= 12) break;
    }
    return out;
  }

  private verificarPersistenciaClipTrasGuardado(validarClip: boolean): void {
    this.adminService.getConfiguracion().subscribe({
      next: (response: any) => {
        const c = response?.configuracion ?? response ?? {};
        const keyMasked = (c?.clip_api_key_masked ?? c?.clip_api_key_prueba_masked ?? '').toString().trim();
        const secretConfigurada = !!(c?.clip_api_secret_configurada ?? c?.clip_api_secret_prueba_configurada);
        const tokenConfigurado = !!(c?.clip_auth_token_configurada);
        this.clipApiKeyPruebaMasked = keyMasked;
        this.clipApiSecretPruebaConfigurada = secretConfigurada;
        this.clipAuthTokenConfigurado = tokenConfigurado;
        this.clipApiKeyPrueba = '';
        this.clipApiSecretPrueba = '';
        this.clipAuthToken = '';
        this.logoService.refrescar();
        this.adminService.refrescarConfiguracionPublica();
        this.cargarConfiguracion();

        if (validarClip) {
          if ((keyMasked && secretConfigurada) || tokenConfigurado) {
            this.modalService.showSuccess('Configuración guardada y credenciales Clip persistidas correctamente.');
          } else {
            this.modalService.showWarning(
              'La configuración se guardó, pero no se pudo confirmar la persistencia de credenciales Clip. Verifica y guarda nuevamente.'
            );
          }
          return;
        }
        this.modalService.showSuccess('Configuración guardada exitosamente');
      },
      error: () => {
        this.clipApiKeyPrueba = '';
        this.clipApiSecretPrueba = '';
        this.logoService.refrescar();
        this.adminService.refrescarConfiguracionPublica();
        this.cargarConfiguracion();
        if (validarClip) {
          this.modalService.showWarning(
            'La configuración se guardó, pero no se pudo validar en este momento la persistencia de credenciales Clip.'
          );
          return;
        }
        this.modalService.showSuccess('Configuración guardada exitosamente');
      }
    });
  }

  paqueteriasPreview(): string {
    const lista = this.parsePaqueteriasDesdeTexto();
    return lista.length ? lista.join(', ') : 'Sin paqueterías';
  }

  private aplicarConfigAHorariosPorDia(): void {
    this.horariosPorDia.forEach((h, i) => {
      h.apertura = this.config.horario_apertura || '09:00';
      h.cierre = this.config.horario_cierre || '20:00';
      if (i === 6) h.abierto = false;
    });
  }

  cargarSillas(): void {
    this.loadingSillas = true;
    this.adminService.getSillas().subscribe({
      next: (res) => {
        this.loadingSillas = false;
        if (res?.ok) {
          this.sillas = res.sillas || [];
        }
      },
      error: () => {
        this.loadingSillas = false;
      }
    });
  }

  onTabChange(tab: typeof this.tabActivo): void {
    this.tabActivo = tab;
    if (tab === 'sillas') this.cargarSillas();
  }

  onLogoFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || !input.files[0]) return;

    const file = input.files[0];
    if (!file.type.startsWith('image/')) {
      this.modalService.showError('Solo se permiten archivos de imagen (PNG, JPG, etc.)');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      this.modalService.showError('La imagen no debe superar 2 MB');
      return;
    }

    // Preview local
    const reader = new FileReader();
    reader.onload = (e) => {
      this.logoPreview = e.target?.result as string;
    };
    reader.readAsDataURL(file);

    // Subir logo al endpoint de configuración
    this.subiendoLogo = true;
    this.adminService.uploadLogoConfiguracion(file).subscribe({
      next: (res) => {
        this.subiendoLogo = false;
        const uploadedUrl = res?.logo_url || res?.url;
        if (uploadedUrl) {
          this.logoUrl = uploadedUrl;
          this.logoPreview = uploadedUrl;
          this.modalService.showSuccess('Logo subido correctamente. No olvides guardar los cambios.');
        } else {
          this.modalService.showError(res?.detail || 'Error al subir el logo');
        }
      },
      error: (error) => {
        this.subiendoLogo = false;
        this.modalService.showError(error?.error?.detail || 'Error al subir el logo');
      }
    });
  }

  eliminarLogo(): void {
    this.logoUrl = '';
    this.logoPreview = '';
    this.logoTipo = 'texto';
  }

  private validarAntesDeGuardar(): boolean {
    if (!this.config.nombre_negocio?.trim()) {
      this.modalService.showError('El nombre del negocio es obligatorio.');
      return false;
    }

    if (this.config.porcentaje_anticipo < 0 || this.config.porcentaje_anticipo > 100) {
      this.modalService.showError('El porcentaje de anticipo debe estar entre 0 y 100.');
      return false;
    }

    if (this.config.tiempo_espera_maximo < 5 || this.config.tiempo_espera_maximo > 60) {
      this.modalService.showError('El tiempo de espera máximo debe estar entre 5 y 60 minutos.');
      return false;
    }

    if (this.config.citas_penalizacion < 1 || this.config.citas_penalizacion > 50) {
      this.modalService.showError('Las citas para liberar penalización deben estar entre 1 y 50.');
      return false;
    }
    if (this.costosEnvio.recoger_local < 0 || this.costosEnvio.moto_mandado < 0 || this.costosEnvio.paqueteria < 0) {
      this.modalService.showError('Los costos de envío no pueden ser negativos.');
      return false;
    }
    if (this.pagoTarjetaActivo && this.clipHabilitado) {
      const ingresoParcialCredenciales = (!!this.clipApiKeyPrueba.trim() && !this.clipApiSecretPrueba.trim())
        || (!this.clipApiKeyPrueba.trim() && !!this.clipApiSecretPrueba.trim());
      if (ingresoParcialCredenciales) {
        this.modalService.showError('Para actualizar Clip debes capturar API Key y API Secret.');
        return false;
      }
      const tieneCredencialesGuardadas = !!(this.clipApiKeyPruebaMasked && this.clipApiSecretPruebaConfigurada);
      const ingresoCredencialesNuevas = !!(this.clipApiKeyPrueba.trim() && this.clipApiSecretPrueba.trim());
      const tieneTokenGuardado = !!this.clipAuthTokenConfigurado;
      const ingresoTokenNuevo = !!this.clipAuthToken.trim();
      if (!tieneCredencialesGuardadas && !ingresoCredencialesNuevas && !tieneTokenGuardado && !ingresoTokenNuevo) {
        this.modalService.showError(
          'Debes configurar Token de autenticación o API Key/API Secret para habilitar pagos con tarjeta.'
        );
        return false;
      }
    }
    if (this.parsePaqueteriasDesdeTexto().length === 0) {
      this.modalService.showError('Debes agregar al menos una paquetería disponible.');
      return false;
    }

    const abiertos = this.horariosPorDia.filter(h => h.abierto);
    if (abiertos.length === 0) {
      this.modalService.showError('Debe haber al menos un día abierto en los horarios.');
      return false;
    }

    for (const h of abiertos) {
      if (!h.apertura || !h.cierre) {
        this.modalService.showError(`Completa apertura y cierre para ${h.dia}.`);
        return false;
      }
      if (h.apertura >= h.cierre) {
        this.modalService.showError(`En ${h.dia}, la hora de cierre debe ser mayor que la de apertura.`);
        return false;
      }
    }

    if (this.logoTipo === 'texto') {
      if (!this.logoTexto?.trim()) {
        this.modalService.showError('La primera parte del logo en texto es obligatoria.');
        return false;
      }
      if (!this.logoTextoAcento?.trim()) {
        this.modalService.showError('La segunda parte del logo en texto es obligatoria.');
        return false;
      }
    }

    const bancoNombre = (this.config.banco_nombre || '').trim();
    const bancoCuentaRaw = (this.config.banco_cuenta || '').trim();
    const bancoTitular = (this.config.banco_titular || '').trim();
    const camposBancariosCompletados = [bancoNombre, bancoCuentaRaw, bancoTitular].filter(Boolean).length;
    if (camposBancariosCompletados > 0 && camposBancariosCompletados < 3) {
      this.modalService.showError('Para transferencia bancaria, completa banco, cuenta/CLABE y titular.');
      return false;
    }
    if (camposBancariosCompletados === 3) {
      const bancoCuenta = bancoCuentaRaw.replace(/\s+/g, '');
      if (!/^\d{10,20}$/.test(bancoCuenta)) {
        this.modalService.showError('La cuenta/CLABE debe contener solo números (10 a 20 dígitos).');
        return false;
      }
    }

    return true;
  }

  guardarConfiguracion(): void {
    if (!this.validarAntesDeGuardar()) {
      return;
    }

    const porcentajeAnticipo = Number(this.config.porcentaje_anticipo);
    const tiempoEsperaMaximo = Number(this.config.tiempo_espera_maximo);
    const citasPenalizacion = Number(this.config.citas_penalizacion);
    const bancoCuentaNormalizada = (this.config.banco_cuenta || '').trim().replace(/\s+/g, '');
    const paqueterias = this.parsePaqueteriasDesdeTexto();

    if (
      Number.isNaN(porcentajeAnticipo) ||
      Number.isNaN(tiempoEsperaMaximo) ||
      Number.isNaN(citasPenalizacion)
    ) {
      this.modalService.showError('Revisa los campos numéricos: hay valores inválidos.');
      return;
    }

    const primerAbierto = this.horariosPorDia.find(h => h.abierto);
    if (primerAbierto) {
      this.config.horario_apertura = primerAbierto.apertura;
      this.config.horario_cierre = primerAbierto.cierre;
    }
    const horarios_por_dia = this.horariosPorDia.map(h => ({
      abierto: h.abierto,
      apertura: h.apertura,
      cierre: h.cierre
    }));
    const horarios = this.horariosPorDia.map((h, index) => ({
      dia_semana: index,
      abierto: h.abierto,
      hora_apertura: h.abierto ? h.apertura : null,
      hora_cierre: h.abierto ? h.cierre : null
    }));
    this.guardando = true;
    const payload: any = {
      nombre_negocio: this.config.nombre_negocio?.trim(),
      telefono: this.config.telefono?.trim(),
      email_contacto: this.config.email_contacto?.trim(),
      // Compatibilidad: algunos backends esperan "direccion", otros "direccion_texto"
      direccion: this.config.direccion?.trim(),
      direccion_texto: this.config.direccion?.trim(),
      porcentaje_anticipo: porcentajeAnticipo,
      tiempo_espera_maximo: tiempoEsperaMaximo,
      citas_penalizacion: citasPenalizacion,
      banco_nombre: this.config.banco_nombre?.trim(),
      banco_titular: this.config.banco_titular?.trim(),
      banco_cuenta: bancoCuentaNormalizada,
      facebook_url: this.config.facebook_url?.trim(),
      instagram_url: this.config.instagram_url?.trim(),
      x_url: this.config.x_url?.trim(),
      tiktok_url: this.config.tiktok_url?.trim(),
      whatsapp_url: this.config.whatsapp_url?.trim(),
      google_maps_url: this.config.google_maps_url?.trim(),
      apple_maps_url: this.config.apple_maps_url?.trim(),
      // Compatibilidad: backend con horarios_por_dia y backend con horarios
      horarios_por_dia,
      horarios,
      costos_envio: {
        recoger_local: Number(this.costosEnvio.recoger_local),
        moto_mandado: Number(this.costosEnvio.moto_mandado),
        paqueteria: Number(this.costosEnvio.paqueteria)
      },
      pago_efectivo_activo: !!this.pagoEfectivoActivo,
      pago_tarjeta_activo: !!this.pagoTarjetaActivo,
      pago_transferencia_activo: !!this.pagoTransferenciaActivo,
      clip_habilitado: !!(this.pagoTarjetaActivo && this.clipHabilitado),
      clip_url: '',
      paqueterias_disponibles: paqueterias,
      logo_tipo: this.logoTipo,
      // Compatibilidad: backend con logo_texto/logo_texto_acento y backend con *_parte1/*_parte2
      logo_texto: this.logoTexto?.trim(),
      logo_texto_acento: this.logoTextoAcento?.trim(),
      logo_texto_parte1: this.logoTexto?.trim(),
      logo_texto_parte2: this.logoTextoAcento?.trim(),
      logo_url: this.logoUrl
    };
    if (this.pagoTarjetaActivo && this.clipHabilitado) {
      const clipKey = this.clipApiKeyPrueba.trim();
      const clipSecret = this.clipApiSecretPrueba.trim();
      const authToken = this.clipAuthToken.trim();
      if (clipKey && clipSecret) {
        payload.clip_api_key = clipKey;
        payload.clip_api_secret = clipSecret;
      }
      if (authToken) {
        payload.clip_auth_token = authToken;
      }
    }
    this.adminService.actualizarConfiguracion(payload).subscribe({
      next: (response) => {
        this.guardando = false;
        if (response?.ok || response?.detail) {
          this.paqueteriasDisponibles = paqueterias;
          const validarPersistenciaClip = !!(
            this.pagoTarjetaActivo &&
            this.clipHabilitado &&
            (this.clipApiKeyPrueba.trim() || this.clipApiSecretPrueba.trim() || this.clipAuthToken.trim())
          );
          this.verificarPersistenciaClipTrasGuardado(validarPersistenciaClip);
        } else {
          this.modalService.showError(response.error || 'Error al guardar');
        }
      },
      error: (error) => {
        if (error?.status === 403 && error?.error?.requires_2fa) {
          this.guardando = true;
          this.adminService.solicitarClip2FA().subscribe({
            next: (res) => {
              this.guardando = false;
              this.clip2FATempToken = res.tempToken ?? '';
              this.pendingConfigPayload = payload;
              this.clip2FACodigo = '';
              this.showClip2FAModal = true;
              this.modalService.showInfo(res.mensaje ?? 'Revisa tu correo e ingresa el código para confirmar el cambio de credenciales Clip.');
            },
            error: () => {
              this.guardando = false;
              this.modalService.showError('No se pudo enviar el código de verificación. Intenta de nuevo.');
            }
          });
          return;
        }
        this.guardando = false;
        const backendDetail =
          error?.error?.detail ||
          error?.error?.error ||
          (Array.isArray(error?.error)
            ? error.error.join(', ')
            : null);
        this.modalService.showError(backendDetail || 'Error al guardar configuración');
      }
    });
  }

  cerrarModalClip2FA(): void {
    this.showClip2FAModal = false;
    this.clip2FACodigo = '';
    this.clip2FATempToken = '';
    this.pendingConfigPayload = null;
  }

  confirmarClip2FA(): void {
    if (!this.clip2FACodigo.trim() || !this.clip2FATempToken || !this.pendingConfigPayload) {
      this.modalService.showError('Ingresa el código de verificación.');
      return;
    }
    const payload = { ...this.pendingConfigPayload as object, codigo_2fa: this.clip2FACodigo.trim(), temp_token_clip: this.clip2FATempToken };
    this.enviandoClip2FA = true;
    this.adminService.actualizarConfiguracion(payload).subscribe({
      next: (response) => {
        this.enviandoClip2FA = false;
        if (response?.ok || response?.detail) {
          this.paqueteriasDisponibles = (payload as any).paqueterias_disponibles ?? this.paqueteriasDisponibles;
        }
        this.cerrarModalClip2FA();
        if (response?.ok || response?.detail) {
          const validarPersistenciaClip = !!(
            this.pagoTarjetaActivo &&
            this.clipHabilitado &&
            (this.clipApiKeyPrueba.trim() || this.clipApiSecretPrueba.trim() || this.clipAuthToken.trim())
          );
          this.verificarPersistenciaClipTrasGuardado(validarPersistenciaClip);
        } else {
          this.modalService.showError(response?.error || 'Error al guardar');
        }
      },
      error: (err) => {
        this.enviandoClip2FA = false;
        const msg = err?.error?.error ?? err?.error?.detail ?? 'Error al guardar configuración. El código puede haber expirado.';
        this.modalService.showError(msg);
      }
    });
  }

  restaurarDefectos(): void {
    if (confirm('¿Restaurar todos los valores a sus valores por defecto?')) {
      this.config = {
        nombre_negocio: 'Stylo Barber',
        direccion: '',
        telefono: '',
        email_contacto: '',
        horario_apertura: '09:00',
        horario_cierre: '20:00',
        porcentaje_anticipo: 30,
        banco_nombre: '',
        banco_cuenta: '',
        banco_titular: '',
        tiempo_espera_maximo: 10,
        citas_penalizacion: 10,
        facebook_url: '',
        instagram_url: '',
        x_url: '',
        tiktok_url: '',
        whatsapp_url: '',
        google_maps_url: '',
        apple_maps_url: ''
      };
      this.inicializarHorariosPorDia();
      this.logoTipo = 'texto';
      this.logoTexto = 'Stylo';
      this.logoTextoAcento = 'Barber';
      this.logoUrl = '';
      this.logoPreview = '';
      this.costosEnvio = { recoger_local: 0, moto_mandado: 45, paqueteria: 150 };
      this.pagoEfectivoActivo = true;
      this.pagoTarjetaActivo = false;
      this.pagoTransferenciaActivo = true;
      this.clipHabilitado = false;
      this.clipUrl = '';
      this.clipApiKeyPrueba = '';
      this.clipApiSecretPrueba = '';
          this.clipAuthToken = '';
      this.clipApiKeyPruebaMasked = '';
      this.clipApiSecretPruebaConfigurada = false;
          this.clipAuthTokenConfigurado = false;
      this.paqueteriasDisponibles = ['DHL', 'Estafeta', 'FedEx', 'Paquetexpress'];
      this.paqueteriasTexto = this.paqueteriasDisponibles.join(', ');
      this.modalService.showInfo('Valores restaurados. No olvides guardar los cambios.');
    }
  }
}
