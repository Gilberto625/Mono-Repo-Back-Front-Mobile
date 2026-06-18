import { Component, OnInit, DestroyRef, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule, FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { FooterComponent } from '../../shared/footer/footer.component';
import { ScrollRevealDirective } from '../../../directives/scroll-reveal.directive';
import { ModalService } from '../../../services/modal.service';
import { AdminService } from '../../../services/admin.service';

/** Info de contacto que se muestra en Contáctanos (viene de Configuración del negocio). */
export interface ContactoInfo {
  telefono: string;
  correo: string;
  direccion: string;
  horario: string;
  facebook_url: string;
  instagram_url: string;
  x_url: string;
  tiktok_url: string;
  whatsapp_url: string;
  google_maps_url: string;
  apple_maps_url: string;
}

const DEFAULTS: ContactoInfo = {
  telefono: '—',
  correo: '—',
  direccion: '—',
  horario: 'Lunes a Sábado: 9:00 - 20:00',
  facebook_url: '',
  instagram_url: '',
  x_url: '',
  tiktok_url: '',
  whatsapp_url: '',
  google_maps_url: '',
  apple_maps_url: ''
};

@Component({
  selector: 'app-contacto',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    FormsModule,
    ReactiveFormsModule,
    NavbarComponent,
    FooterComponent,
    ScrollRevealDirective
  ],
  templateUrl: './contacto.component.html',
  styleUrl: './contacto.component.css'
})
export class ContactoComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly modalService = inject(ModalService);
  private readonly adminService = inject(AdminService);
  private readonly destroyRef = inject(DestroyRef);

  contactoForm: FormGroup;
  loading = false;
  /** Datos del negocio para la sección "Información de contacto" (y horarios). */
  contactoInfo: ContactoInfo = { ...DEFAULTS };
  cargandoInfo = true;

  constructor() {
    this.contactoForm = this.fb.group({
      nombre: ['', [Validators.required, Validators.minLength(2)]],
      correo: ['', [Validators.required, Validators.email]],
      telefono: ['', [Validators.required, Validators.pattern(/^\d{10}$/)]],
      asunto: ['', [Validators.required]],
      mensaje: ['', [Validators.required, Validators.minLength(10)]]
    });
  }

  ngOnInit(): void {
    this.adminService.configuracionPublica$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((res) => {
        if (!res?.ok || !res.configuracion) return;
        this.aplicarConfiguracion(res.configuracion);
      });

    // Si hay cache, llega por `configuracionPublica$` al instante.
    // Luego refrescamos en background (deduplicado en el service).
    this.cargandoInfo = !this.contactoInfo || this.contactoInfo === DEFAULTS;
    this.adminService.refrescarConfiguracionPublica();
  }

  private aplicarConfiguracion(c: any): void {
          this.contactoInfo = {
            telefono: c.telefono?.trim() || DEFAULTS.telefono,
            correo: c.email_contacto?.trim() || DEFAULTS.correo,
            direccion: c.direccion?.trim() || DEFAULTS.direccion,
            horario: this.formatearHorarioTexto(c.horarios_por_dia, c.horario_apertura, c.horario_cierre),
            facebook_url: c.facebook_url || '',
            instagram_url: c.instagram_url || '',
            x_url: c.x_url || '',
            tiktok_url: c.tiktok_url || '',
      whatsapp_url: c.whatsapp_url || '',
            google_maps_url: c.google_maps_url || '',
            apple_maps_url: c.apple_maps_url || ''
          };
    this.cargandoInfo = false;
  }

  /** Texto de horario para mostrar. Si hay horarios_por_dia, muestra por día; si no, usa apertura/cierre global. */
  private formatearHorarioTexto(
    horariosPorDia?: { abierto: boolean; apertura?: string; cierre?: string }[],
    apertura?: string,
    cierre?: string
  ): string {
    if (Array.isArray(horariosPorDia) && horariosPorDia.length >= 7) {
      const dias = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
      const lineas = dias.map((nombre, i) => {
        const h = horariosPorDia[i];
        if (!h?.abierto) return `${nombre}: Cerrado`;
        const a = this.normalizarHora(h.apertura) || '09:00';
        const c = this.normalizarHora(h.cierre) || '20:00';
        return `${nombre}: ${a} - ${c}`;
      });
      return lineas.join('\n');
    }
    const a = this.normalizarHora(apertura);
    const c = this.normalizarHora(cierre);
    if (a && c) return `Lunes a Sábado: ${a} - ${c}`;
    return DEFAULTS.horario;
  }

  private normalizarHora(val: string | undefined): string | undefined {
    if (val == null || val === '') return undefined;
    const s = String(val).trim();
    return s.length > 5 ? s.substring(0, 5) : s;
  }

  onSubmit(): void {
    if (this.contactoForm.valid) {
      this.loading = true;
      // Sin mock delay: feedback inmediato.
      this.loading = false;
      this.modalService.showSuccess(
        'Gracias por contactarnos. Te responderemos en un plazo de 24-48 horas.',
        '¡Mensaje enviado!'
      );
      this.contactoForm.reset();
    } else {
      this.modalService.showError(
        'Por favor completa todos los campos correctamente.'
      );
    }
  }
}
