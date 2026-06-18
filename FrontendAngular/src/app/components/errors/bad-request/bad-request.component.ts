import { Component } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { RouterModule } from '@angular/router';
import { NavbarComponent } from '../../shared/navbar/navbar.component';
import { FooterComponent } from '../../shared/footer/footer.component';

@Component({
  selector: 'app-bad-request',
  standalone: true,
  imports: [CommonModule, RouterModule, NavbarComponent, FooterComponent],
  templateUrl: './bad-request.component.html',
  styleUrl: './bad-request.component.css'
})
export class BadRequestComponent {
  errorCode = '400';
  errorTitle = 'Solicitud incorrecta';
  errorMessage = 'La solicitud que intentaste realizar no es válida. Por favor, verifica los datos e intenta nuevamente.';

  constructor(private location: Location) {}

  goBack(): void {
    this.location.back();
  }
}
