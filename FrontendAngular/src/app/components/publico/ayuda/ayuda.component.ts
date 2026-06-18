import { Component, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { FooterComponent } from '../../shared/footer/footer.component';
import { ScrollRevealDirective } from '../../../directives/scroll-reveal.directive';

@Component({
  selector: 'app-ayuda',
  standalone: true,
  imports: [CommonModule, RouterModule, NavbarComponent, FooterComponent, ScrollRevealDirective],
  templateUrl: './ayuda.component.html',
  styleUrl: './ayuda.component.css'
})
export class AyudaComponent {
  readonly search = signal('');

  readonly faqsFiltradas = computed(() => {
    const q = this.search().trim().toLowerCase();
    if (!q) return this.faqs;
    return this.faqs
      .map((cat) => ({
        categoria: cat.categoria,
        preguntas: cat.preguntas.filter(
          (f) =>
            f.pregunta.toLowerCase().includes(q) ||
            f.respuesta.toLowerCase().includes(q) ||
            cat.categoria.toLowerCase().includes(q)
        )
      }))
      .filter((c) => c.preguntas.length > 0);
  });

  faqs = [
    {
      categoria: 'Reservas y Citas',
      preguntas: [
        {
          pregunta: '¿Cómo puedo agendar una cita?',
          respuesta: 'Puedes agendar una cita desde la sección "Agendar Cita" en el menú principal. Selecciona el servicio, barbero, fecha y hora que prefieras. Se requiere un anticipo del 30% para confirmar tu cita.'
        },
        {
          pregunta: '¿Puedo cancelar o reprogramar mi cita?',
          respuesta: 'Sí, puedes cancelar o reprogramar tu cita desde la sección "Mis Citas" en tu panel de cliente. Las cancelaciones con menos de 24 horas de anticipación pueden estar sujetas a penalización según nuestras políticas.'
        },
        {
          pregunta: '¿Qué métodos de pago aceptan?',
          respuesta: 'Aceptamos tarjeta de crédito/débito, transferencia bancaria (SPEI) y Mercado Pago. El anticipo se puede pagar en línea, y el resto se paga en la sucursal.'
        }
      ]
    },
    {
      categoria: 'Servicios',
      preguntas: [
        {
          pregunta: '¿Qué servicios ofrecen?',
          respuesta: 'Ofrecemos cortes de cabello, barba, tratamientos capilares, afeitado clásico, y servicios premium. Puedes ver todos nuestros servicios en la sección "Servicios" del menú.'
        },
        {
          pregunta: '¿Cuánto tiempo dura un servicio?',
          respuesta: 'La duración varía según el servicio. Un corte básico toma aproximadamente 30-45 minutos, mientras que servicios más complejos pueden tomar hasta 90 minutos. La duración exacta se muestra al seleccionar cada servicio.'
        },
        {
          pregunta: '¿Ofrecen servicios a domicilio?',
          respuesta: 'Actualmente nuestros servicios se realizan únicamente en nuestra sucursal. Estamos trabajando en implementar servicios a domicilio en el futuro.'
        }
      ]
    },
    {
      categoria: 'Productos',
      preguntas: [
        {
          pregunta: '¿Venden productos de barbería?',
          respuesta: 'Sí, tenemos un catálogo completo de productos de barbería incluyendo pomadas, geles, aceites, navajas y más. Puedes verlos en la sección "Productos" y realizar pedidos en línea.'
        },
        {
          pregunta: '¿Hacen envíos?',
          respuesta: 'Sí, realizamos envíos a toda la república mexicana. Los tiempos de entrega varían según la ubicación. También puedes recoger tu pedido en la sucursal sin costo adicional.'
        },
        {
          pregunta: '¿Qué métodos de pago aceptan para productos?',
          respuesta: 'Aceptamos los mismos métodos de pago que para servicios: tarjeta, transferencia bancaria y Mercado Pago.'
        }
      ]
    },
    {
      categoria: 'Cuenta y Perfil',
      preguntas: [
        {
          pregunta: '¿Cómo creo una cuenta?',
          respuesta: 'Puedes crear una cuenta haciendo clic en "Registro" desde la página de inicio de sesión. Necesitarás proporcionar tu información personal y verificar tu correo electrónico mediante un código de dos factores.'
        },
        {
          pregunta: '¿Olvidé mi contraseña, qué hago?',
          respuesta: 'Puedes recuperar tu contraseña desde la página de inicio de sesión haciendo clic en "¿Olvidaste tu contraseña?". Te enviaremos un enlace de recuperación a tu correo electrónico.'
        },
        {
          pregunta: '¿Cómo cambio mi información personal?',
          respuesta: 'Puedes actualizar tu información personal desde tu perfil en el panel de cliente. Ve a "Mi Perfil" y edita los campos que desees cambiar.'
        }
      ]
    },
    {
      categoria: 'Políticas',
      preguntas: [
        {
          pregunta: '¿Cuál es su política de cancelación?',
          respuesta: 'Las cancelaciones con más de 24 horas de anticipación no tienen penalización. Cancelaciones con menos de 24 horas pueden estar sujetas a una penalización del 20% del anticipo pagado.'
        },
        {
          pregunta: '¿Ofrecen garantía en sus servicios?',
          respuesta: 'Estamos comprometidos con la satisfacción del cliente. Si no estás satisfecho con el servicio, contáctanos dentro de las 48 horas y trabajaremos contigo para resolverlo.'
        },
        {
          pregunta: '¿Cuál es su política de privacidad?',
          respuesta: 'Respetamos tu privacidad y protegemos tu información personal. Toda la información se maneja de acuerdo con nuestra política de privacidad y las leyes aplicables. Puedes revisar los detalles en nuestra página de configuración.'
        }
      ]
    }
  ];

  categoriaAbierta: string | null = null;
  preguntaAbierta: string | null = null;

  toggleCategoria(categoria: string): void {
    this.categoriaAbierta = this.categoriaAbierta === categoria ? null : categoria;
  }

  togglePregunta(pregunta: string): void {
    this.preguntaAbierta = this.preguntaAbierta === pregunta ? null : pregunta;
  }

  esCategoriaAbierta(categoria: string): boolean {
    return this.categoriaAbierta === categoria;
  }

  esPreguntaAbierta(pregunta: string): boolean {
    return this.preguntaAbierta === pregunta;
  }

  onSearchInput(event: Event): void {
    const v = (event.target as HTMLInputElement).value;
    this.search.set(v);
  }
}
