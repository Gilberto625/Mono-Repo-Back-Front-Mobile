"""
Pruebas E2E HTTP read-only/write controlado contra Django local + Neon staging.
No imprime tokens completos ni secretos.
"""
import json
import os
import sys
from datetime import date, timedelta

import django
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "core.settings")
django.setup()

from decouple import config

BASE = os.environ.get("E2E_API_BASE", "http://127.0.0.1:8000/api")
PASSWORD = config("E2E_STAGING_PASSWORD", default="E2E_TEST_Stylo2026!")
RESULTS: list[dict] = []


def record(name: str, method: str, path: str, status: int, ok: bool, note: str = ""):
    RESULTS.append(
        {"name": name, "method": method, "path": path, "status": status, "ok": ok, "note": note}
    )
    flag = "OK" if ok else "FAIL"
    print(f"[{flag}] {name}: {method} {path} -> {status} {note}")


def req(method: str, path: str, *, token: str | None = None, json_body: dict | None = None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    url = f"{BASE.rstrip('/')}{path}"
    try:
        r = requests.request(method, url, headers=headers, json=json_body, timeout=30)
        body = {}
        try:
            body = r.json() if r.content else {}
        except Exception:
            body = {"raw": r.text[:200]}
        return r.status_code, body
    except requests.RequestException as exc:
        return 0, {"error": type(exc).__name__}


def login(username: str) -> tuple[int, dict]:
    return req("POST", "/login/", json_body={"email": username, "password": PASSWORD})


def main():
    # Health
    st, _ = req("GET", "/health/")
    record("health", "GET", "/health/", st, st == 200)

    # Catalog
    st, body = req("GET", "/public/servicios/")
    e2e_srv = any(
        "E2E_TEST" in str(s.get("nombre", "")) for s in (body.get("servicios") or [])
    )
    record("catalog_servicios", "GET", "/public/servicios/", st, st == 200, f"e2e_service={e2e_srv}")

    st, body = req("GET", "/public/productos/")
    e2e_prod = any("E2E_TEST" in str(p.get("nombre", "")) for p in (body if isinstance(body, list) else []))
    record("catalog_productos", "GET", "/public/productos/", st, st == 200, f"e2e_product={e2e_prod}")

    # Invalid login
    st, _ = req("POST", "/login/", json_body={"email": "invalido_e2e@test.stylo.local", "password": "wrong"})
    record("login_invalid", "POST", "/login/", st, st in (400, 401))

    # Admin login
    st, admin_body = login("e2e_admin_stylo")
    admin_token = admin_body.get("access", "") if st == 200 else ""
    record("login_admin", "POST", "/login/", st, st == 200 and bool(admin_token))

    # Cliente login
    st, client_body = login("e2e_cliente_stylo")
    client_token = client_body.get("access", "") if st == 200 else ""
    record(
        "login_cliente",
        "POST",
        "/login/",
        st,
        st == 200 and bool(client_token),
        f"requires2fa={client_body.get('requires2fa')}",
    )

    # Refresh
    refresh = client_body.get("refresh", "")
    if refresh:
        st, ref_body = req("POST", "/auth/token/refresh/", json_body={"refresh": refresh})
        record("token_refresh", "POST", "/auth/token/refresh/", st, st == 200 and bool(ref_body.get("access")))

    # Mis citas sin token
    st, _ = req("GET", "/mis-citas/")
    record("mis_citas_anon", "GET", "/mis-citas/", st, st == 401)

    # Mis citas cliente
    st, mc_body = req("GET", "/mis-citas/", token=client_token)
    record("mis_citas_cliente", "GET", "/mis-citas/", st, st == 200)

    # Barberos + disponibilidad + crear cita
    servicio_id = 16
    st, barb_body = req("GET", f"/barberos/?servicio_id={servicio_id}", token=client_token)
    barberos = barb_body.get("barberos") or []
    barbero_id = None
    for b in barberos:
        if "e2e_barbero" in str(b.get("username", "")).lower():
            barbero_id = b.get("id")
            break
    if not barbero_id and barberos:
        barbero_id = barberos[0].get("id")
    record("barberos", "GET", "/barberos/", st, st == 200, f"count={len(barberos)}")

    fecha = (date.today() + timedelta(days=5)).isoformat()
    hora = "10:00"
    if barbero_id:
        st, disp_body = req(
            "GET",
            f"/disponibilidad/?barbero_id={barbero_id}&fecha={fecha}&duracion=30",
            token=client_token,
        )
        horarios = disp_body.get("horarios") or []
        disponibles = [h for h in horarios if h.get("disponible")]
        if disponibles:
            hora = str(disponibles[0].get("hora", hora))[:5]
        record("disponibilidad", "GET", "/disponibilidad/", st, st == 200, f"slots={len(disponibles)}")

        cita_payload = {
            "barbero_id": barbero_id,
            "servicio_id": servicio_id,
            "fecha": fecha,
            "hora": hora,
            "comprobante_pago": "",
            "codigo_descuento": "",
            "notas": "E2E_TEST cita staging",
        }
        forbidden = {
            "precio_total",
            "descuento",
            "anticipo_monto",
            "porcentaje",
            "porcentaje_anticipo",
            "penalizada",
            "modo_cobro",
        }
        assert not forbidden.intersection(cita_payload.keys())
        st, cita_res = req("POST", "/citas/", token=client_token, json_body=cita_payload)
        has_totals = any(k in cita_res for k in ("precio_total", "anticipo", "restante", "total"))
        record(
            "crear_cita",
            "POST",
            "/citas/",
            st,
            st in (200, 201) and cita_res.get("ok"),
            f"backend_totals={has_totals}",
        )
        cita_id = cita_res.get("id") or cita_res.get("cita_id")
    else:
        record("disponibilidad", "GET", "/disponibilidad/", 0, False, "sin barbero")
        record("crear_cita", "POST", "/citas/", 0, False, "sin barbero")
        cita_id = None

    # Pedido
    st, prod_body = req("GET", "/public/productos/")
    producto_id = None
    for p in prod_body if isinstance(prod_body, list) else []:
        if "E2E_TEST" in str(p.get("nombre", "")):
            producto_id = p.get("id")
            break
    pedido_payload = {
        "items": [{"producto_id": producto_id or 21, "cantidad": 1}],
        "metodo_entrega": "recoger_local",
        "metodo_pago": "efectivo",
        "notas": "E2E_TEST pedido staging",
    }
    forbidden_ped = {"subtotal", "descuento", "costo_envio", "total"}
    assert not forbidden_ped.intersection(pedido_payload.keys())
    st, ped_res = req("POST", "/pedidos/crear/", token=client_token, json_body=pedido_payload)
    pedido_id = ped_res.get("pedido_id") or ped_res.get("id") or (ped_res.get("pedido") or {}).get("id")
    has_ped_totals = any(
        k in ped_res or k in (ped_res.get("pedido") or {})
        for k in ("subtotal", "total", "descuento", "costo_envio")
    )
    record(
        "crear_pedido",
        "POST",
        "/pedidos/crear/",
        st,
        st in (200, 201) and (ped_res.get("ok") or pedido_id),
        f"backend_totals={has_ped_totals}",
    )

    # Clip intent (sin pago real)
    if pedido_id:
        clip_payload = {
            "tipo": "pedido",
            "pedido_id": pedido_id,
            "cliente_email": "e2e_cliente_stylo@test.stylo.local",
        }
        assert "monto" not in clip_payload and "amount" not in clip_payload
        st, clip_res = req("POST", "/pagos/clip/intentar/", token=client_token, json_body=clip_payload)
        checkout = str(clip_res.get("checkout_url") or "")
        https_ok = (not checkout) or checkout.startswith("https://")
        record(
            "clip_intent",
            "POST",
            "/pagos/clip/intentar/",
            st,
            st in (200, 400, 402, 502, 503) and https_ok,
            f"estado={str(clip_res.get('estado_pago') or clip_res.get('error', ''))[:60]}",
        )
    else:
        record("clip_intent", "POST", "/pagos/clip/intentar/", 0, False, "sin pedido")

    # Guards API (proxy de guards visuales)
    st, _ = req("GET", "/admin/dashboard/", token=client_token)
    record("guard_cliente_admin", "GET", "/admin/dashboard/", st, st in (401, 403))
    st, _ = req("GET", "/admin/empleados/", token=client_token)
    record("guard_cliente_admin_empleados", "GET", "/admin/empleados/", st, st in (401, 403))
    st, _ = req("GET", "/secretaria/dashboard/", token=client_token)
    record("guard_cliente_secretaria", "GET", "/secretaria/dashboard/", st, st in (401, 403))
    st, _ = req("GET", "/mis-citas/")
    record("guard_anon_mis_citas", "GET", "/mis-citas/", st, st == 401)
    st, _ = req("GET", "/admin/dashboard/", token=admin_token)
    record("guard_admin_dashboard", "GET", "/admin/dashboard/", st, st == 200)

    # Dashboard admin cliente stats
    # Dashboard admin stats
    st, _ = req("GET", "/dashboard-stats/", token=admin_token)
    record("dashboard_admin", "GET", "/dashboard-stats/", st, st == 200)

    passed = sum(1 for r in RESULTS if r["ok"])
    print(f"\nSUMMARY: {passed}/{len(RESULTS)} passed")
    return 0 if passed == len(RESULTS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
