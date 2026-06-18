import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

interface Mensaje {
  id: number;
  texto: string;
  esUsuario: boolean;
  timestamp: Date;
}

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './chat.component.html',
  styleUrl: './chat.component.css'
})
export class ChatComponent implements OnInit, OnDestroy {
  mensajes: Mensaje[] = [];
  nuevoMensaje = '';
  chatAbierto = false;
  private mensajeId = 0;

  ngOnInit(): void {
    // Mensaje de bienvenida inicial
    this.agregarMensajeSistema('¡Hola! 👋 Bienvenido al chat de Stylo Barber. ¿En qué puedo ayudarte?');
  }

  ngOnDestroy(): void {
    // Limpiar si es necesario
  }

  toggleChat(): void {
    this.chatAbierto = !this.chatAbierto;
  }

  enviarMensaje(): void {
    if (this.nuevoMensaje.trim()) {
      this.agregarMensaje(this.nuevoMensaje, true);
      this.nuevoMensaje = '';
      
      // Simular respuesta automática después de 1 segundo
      setTimeout(() => {
        this.responderMensaje();
      }, 1000);
    }
  }

  private agregarMensaje(texto: string, esUsuario: boolean): void {
    this.mensajes.push({
      id: this.mensajeId++,
      texto,
      esUsuario,
      timestamp: new Date()
    });
    this.scrollToBottom();
  }

  private agregarMensajeSistema(texto: string): void {
    this.agregarMensaje(texto, false);
  }

  private responderMensaje(): void {
    const respuestas = [
      'Gracias por tu mensaje. Nuestro equipo te responderá pronto. ¿Hay algo más en lo que pueda ayudarte?',
      'Entendido. ¿Te gustaría agendar una cita o consultar sobre nuestros servicios?',
      'Perfecto. Puedo ayudarte con información sobre servicios, productos o citas. ¿Qué necesitas?',
      'Gracias por contactarnos. Si tienes alguna pregunta específica, no dudes en preguntar.',
      'Estoy aquí para ayudarte. ¿Necesitas información sobre algún servicio en particular?'
    ];
    
    const respuesta = respuestas[Math.floor(Math.random() * respuestas.length)];
    this.agregarMensaje(respuesta, false);
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      const chatContainer = document.querySelector('.chat-messages');
      if (chatContainer) {
        chatContainer.scrollTop = chatContainer.scrollHeight;
      }
    }, 100);
  }

  formatearHora(fecha: Date): string {
    return fecha.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  }
}
