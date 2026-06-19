export const API_ENDPOINTS = {
  health: '/health/',
  auth: {
    login: '/login/',
    loginGoogle: '/login/google/',
    login2faVerify: '/login/2fa/verificar/',
    login2faRequestCode: '/login/2fa/solicitar-codigo/',
    register: '/register/',
    register2faVerify: '/register/2fa/verificar/',
    verifyOtp: '/verificar-otp/',
    resendOtp: '/reenviar-otp/',
    refresh: '/auth/token/refresh/',
    tokenVerify: '/auth/token/verify/',
    me: '/auth/me/',
    profile: '/perfil/',
    profilePassword: '/perfil/cambiar-contrasena/',
    profileAvatar: '/perfil/upload-avatar/',
    profile2fa: '/perfil/2fa/',
    recoverOtp: '/recuperar-otp/',
    verifyRecoveryOtp: '/verificar-otp-recuperacion/',
    resendRecoveryOtp: '/reenviar-otp-recuperacion/',
    updatePasswordOtp: '/actualizar-contrasena-otp/'
  },
  client: {
    dashboardStats: '/dashboard-stats/',
    myAppointments: '/mis-citas/',
    appointments: '/citas/',
    appointmentPaymentPolicy: '/citas/politica-pago/',
    barbers: '/barberos/',
    availability: '/disponibilidad/',
    receiptsUpload: '/comprobantes/upload/'
  },
  public: {
    services: '/public/servicios/',
    products: '/public/productos/',
    contact: '/public/contacto/',
    publicConfig: '/configuracion-publica/',
    legal: '/contenido-legal/'
  },
  orders: {
    list: '/pedidos/',
    create: '/pedidos/crear/'
  },
  promotions: {
    validate: '/promociones/validar/'
  },
  payments: {
    clipIntent: '/pagos/clip/intentar/'
  },
  admin: {
    dashboard: '/admin/dashboard/',
    configuration: '/admin/configuracion/',
    services: '/admin/servicios/',
    products: '/admin/productos/',
    employees: '/admin/empleados/',
    promotions: '/admin/promociones/',
    inventoryMovements: '/admin/inventario/movimientos/',
    reports: '/admin/reportes/',
    legalContent: '/admin/contenido-legal/',
    chairs: '/admin/sillas/',
    brands: '/admin/marcas/'
  },
  secretaria: {
    dashboard: '/secretaria/dashboard/',
    appointments: '/secretaria/citas/',
    orders: '/secretaria/pedidos/'
  }
} as const;

export function apiEndpoint(apiUrl: string, path: string): string {
  return `${apiUrl.replace(/\/$/, '')}${path}`;
}

export function publicServiceDetailPath(serviceId: number | string): string {
  return `/public/servicios/${serviceId}/`;
}

export function apiEndpointWithQuery(
  apiUrl: string,
  path: string,
  params: Record<string, string | number | boolean | undefined | null>
): string {
  const base = apiEndpoint(apiUrl, path);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}
