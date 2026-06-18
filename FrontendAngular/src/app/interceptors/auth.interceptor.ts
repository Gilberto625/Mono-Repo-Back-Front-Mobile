import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { BehaviorSubject, catchError, filter, switchMap, take, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

let isRefreshing = false;
const refreshTokenSubject = new BehaviorSubject<string | null>(null);

function addAuthHeader(req: HttpRequest<unknown>, token: string) {
  return req.clone({
    setHeaders: {
      Authorization: `Bearer ${token}`
    }
  });
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const accessToken = localStorage.getItem('accessToken');

  // Evita modificar la solicitud de refresh para no enviar un access token vencido.
  const isRefreshRequest = req.url.includes('/auth/token/refresh/');
  const isTokenRequest = req.url.includes('/auth/token/');
  const isLoginRequest = req.url.includes('/api/login/');
  const isRegisterFlowRequest =
    req.url.includes('/api/register/') ||
    req.url.includes('/api/verificar-otp/') ||
    req.url.includes('/api/reenviar-otp/');
  const isRecoveryFlowRequest =
    req.url.includes('/api/recuperar-otp/') ||
    req.url.includes('/api/verificar-otp-recuperacion/') ||
    req.url.includes('/api/reenviar-otp-recuperacion/') ||
    req.url.includes('/api/actualizar-contrasena-otp/');

  const shouldSkipAuthHeader = isRefreshRequest || isTokenRequest || isLoginRequest || isRegisterFlowRequest || isRecoveryFlowRequest;
  const requestWithAuth = accessToken && !shouldSkipAuthHeader ? addAuthHeader(req, accessToken) : req;

  return next(requestWithAuth).pipe(
    catchError((error: HttpErrorResponse) => {
      const shouldTryRefresh = error.status === 401 && !shouldSkipAuthHeader;

      if (!shouldTryRefresh) {
        if (error.status === 401) {
          authService.logout();
        }
        return throwError(() => error);
      }

      if (!isRefreshing) {
        isRefreshing = true;
        refreshTokenSubject.next(null);

        return authService.refreshToken().pipe(
          switchMap((newAccessToken) => {
            isRefreshing = false;

            if (!newAccessToken) {
              authService.logout();
              return throwError(() => error);
            }

            refreshTokenSubject.next(newAccessToken);
            return next(addAuthHeader(req, newAccessToken));
          }),
          catchError((refreshError) => {
            isRefreshing = false;
            authService.logout();
            return throwError(() => refreshError);
          })
        );
      }

      return refreshTokenSubject.pipe(
        filter((token) => token !== null),
        take(1),
        switchMap((token) => next(addAuthHeader(req, token as string)))
      );
    })
  );
};
