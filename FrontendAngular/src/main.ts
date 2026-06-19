import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, appConfig).catch(() => {
  const errorDiv = document.createElement('div');
  errorDiv.style.cssText = 'padding: 20px; font-family: Arial, sans-serif; background: #f5f5f5; color: #333;';
  const title = document.createElement('h1');
  title.style.color = '#d32f2f';
  title.textContent = 'Error al cargar la aplicación';
  const message = document.createElement('p');
  message.textContent = 'Por favor, recarga la página. Si el problema persiste, inténtalo más tarde.';
  errorDiv.append(title, message);
  document.body.appendChild(errorDiv);
});
