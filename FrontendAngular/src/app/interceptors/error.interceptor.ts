import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);

  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
      // Para errores 404: redirigir si no es una ruta de API o si es una ruta de navegación
      if (error.status === 404) {
        if (!req.url.includes('/api/')) {
          router.navigate(['/404']);
        }
        // Si es API 404, dejar que el componente lo maneje
      } 
      // Errores 500 en API: no redirigir (el componente puede mostrar mensaje y reintentar).
      // Redirigir solo si la petición no es a la API (p. ej. carga de asset en ruta equivocada).
      else if (error.status === 500 && !req.url.includes('/api/')) {
        router.navigate(['/500']);
      }
      // Para errores 400: solo redirigir si no es API (errores de validación del servidor)
      else if (error.status === 400 && !req.url.includes('/api/')) {
        router.navigate(['/400']);
      }
      
      // Para otros errores de API, dejar que los componentes los manejen
      return throwError(() => error);
    })
  );
};
