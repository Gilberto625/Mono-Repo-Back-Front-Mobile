import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface AlexaEstadoResponse {
  ok: boolean;
  vinculado: boolean;
  vinculado_en?: string;
  error?: string;
}

export interface AlexaCodigoResponse {
  ok: boolean;
  codigo?: string;
  expira_en_segundos?: number;
  error?: string;
}

@Injectable({
  providedIn: 'root'
})
export class AlexaService {
  private readonly http = inject(HttpClient);
  private readonly apiUrl = environment.apiUrl.replace(/\/$/, '');

  getEstadoVinculacion(): Observable<AlexaEstadoResponse> {
    return this.http.get<AlexaEstadoResponse>(`${this.apiUrl}/alexa/estado-vinculacion/`);
  }

  generarCodigoVinculacion(): Observable<AlexaCodigoResponse> {
    return this.http.post<AlexaCodigoResponse>(`${this.apiUrl}/alexa/codigo-vinculacion/`, {});
  }
}
