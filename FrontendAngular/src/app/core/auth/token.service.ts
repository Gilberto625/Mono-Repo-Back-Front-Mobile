import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class TokenService {
  private readonly accessKey = 'accessToken';
  private readonly refreshKey = 'refreshToken';

  // Compatibilidad temporal: el refresh token debe migrarse a cookie HttpOnly.
  getAccessToken(): string | null {
    return localStorage.getItem(this.accessKey);
  }

  getRefreshToken(): string | null {
    return localStorage.getItem(this.refreshKey);
  }

  setTokens(access: string, refresh: string): void {
    localStorage.setItem(this.accessKey, access);
    localStorage.setItem(this.refreshKey, refresh);
  }

  setAccessToken(access: string): void {
    localStorage.setItem(this.accessKey, access);
  }

  clear(): void {
    localStorage.removeItem(this.accessKey);
    localStorage.removeItem(this.refreshKey);
  }
}
