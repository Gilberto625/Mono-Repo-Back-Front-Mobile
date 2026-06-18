import { Component } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { RouterModule } from '@angular/router';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { FooterComponent } from '../../shared/footer/footer.component';

@Component({
  selector: 'app-server-error',
  standalone: true,
  imports: [CommonModule, RouterModule, NavbarComponent, FooterComponent],
  templateUrl: './server-error.component.html',
  styleUrl: './server-error.component.css'
})
export class ServerErrorComponent {
  errorCode = '500';
  errorTitle = 'Error del servidor';
  errorMessage = 'Algo salió mal en nuestro servidor. Nuestro equipo ha sido notificado y está trabajando para solucionarlo.';

  constructor(private location: Location) {}

  goBack(): void {
    this.location.back();
  }
}
