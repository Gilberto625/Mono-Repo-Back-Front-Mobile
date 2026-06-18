"""
Correos transaccionales con estética Stylo Barber (tema oscuro + acento dorado).
HTML con estilos en línea para compatibilidad con clientes de correo.
"""

from __future__ import annotations

import html
import json
import logging
from email.utils import formataddr
import urllib.error as urllib_error
import urllib.request as urllib_request
from typing import Tuple

from django.conf import settings
from django.core.mail import send_mail

logger = logging.getLogger(__name__)


def build_otp_plain(
    *,
    title: str,
    lead: str,
    codigo: str,
    minutes: int,
    footer: str = "",
) -> str:
    lines = [
        title,
        "",
        lead,
        "",
        codigo,
        "",
        f"Este código expira en {minutes} minutos.",
    ]
    if footer:
        lines.extend(["", footer])
    return "\n".join(lines)


def build_otp_html(
    *,
    eyebrow: str,
    title: str,
    lead: str,
    codigo: str,
    minutes: int,
    footer: str = "",
) -> str:
    e_eyebrow = html.escape(eyebrow)
    e_title = html.escape(title)
    e_lead = html.escape(lead)
    e_codigo = html.escape(codigo, quote=True)
    e_footer = html.escape(footer) if footer else ""

    # Paleta alineada con theme-tokens.css (tema oscuro)
    bg = "#0a100e"
    card = "#121c18"
    card_border = "rgba(212, 175, 55, 0.28)"
    gold = "#d4af37"
    gold_dim = "rgba(212, 175, 55, 0.12)"
    text = "#eef3f0"
    muted = "rgba(238, 243, 240, 0.68)"
    footer_muted = "rgba(238, 243, 240, 0.45)"

    footer_block = ""
    if e_footer:
        footer_block = f'<p style="margin:20px 0 0;font-size:13px;line-height:1.5;color:{footer_muted};">{e_footer}</p>'

    return f"""<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background:{bg};-webkit-text-size-adjust:100%;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:{bg};padding:28px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:520px;border-collapse:collapse;">
          <tr>
            <td style="padding:0 0 18px;text-align:center;">
              <span style="font-family:'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;font-size:20px;font-weight:800;letter-spacing:-0.03em;color:{text};">Stylo <span style="color:{gold};">Barber</span></span>
              <span style="display:block;margin-top:6px;font-family:'Segoe UI',Roboto,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:{gold};">{e_eyebrow}</span>
            </td>
          </tr>
          <tr>
            <td style="background:{card};border:1px solid {card_border};border-radius:18px;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.45);">
              <div style="height:3px;background:linear-gradient(90deg,transparent,{gold},transparent);"></div>
              <div style="padding:28px 24px 26px;font-family:'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
                <h1 style="margin:0 0 10px;font-size:22px;font-weight:800;line-height:1.25;color:{text};">{e_title}</h1>
                <p style="margin:0 0 22px;font-size:15px;line-height:1.5;color:{muted};">{e_lead}</p>
                <div style="text-align:center;padding:18px 16px;background:{gold_dim};border:1px solid {card_border};border-radius:14px;border-left:3px solid {gold};">
                  <span style="display:inline-block;font-family:Consolas,'Courier New',monospace;font-size:28px;font-weight:700;letter-spacing:0.35em;color:{gold};">{e_codigo}</span>
                </div>
                <p style="margin:20px 0 0;font-size:13px;line-height:1.45;color:{muted};">Válido por <strong style="color:{text};">{minutes} minutos</strong>. No compartas este código con nadie.</p>
                {footer_block}
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 8px 0;text-align:center;">
              <p style="margin:0;font-family:'Segoe UI',Roboto,sans-serif;font-size:11px;line-height:1.5;color:{footer_muted};">Stylo Barber Connect · Mensaje automático</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""


def build_otp_email_pair(
    *,
    eyebrow: str,
    title: str,
    lead: str,
    codigo: str,
    minutes: int,
    footer: str = "",
) -> Tuple[str, str]:
    plain = build_otp_plain(title=title, lead=lead, codigo=codigo, minutes=minutes, footer=footer)
    html_body = build_otp_html(
        eyebrow=eyebrow,
        title=title,
        lead=lead,
        codigo=codigo,
        minutes=minutes,
        footer=footer,
    )
    return plain, html_body


def _send_brevo_api(
    *,
    to_email: str,
    subject: str,
    plain: str,
    html_body: str,
    remitente: str,
    nombre_remitente: str,
    timeout: int,
) -> bool:
    """Brevo transactional email por HTTPS (compatible con Render free: sin puerto SMTP)."""
    api_key = str(getattr(settings, "BREVO_API_KEY", "") or "").strip()
    if not api_key:
        return False
    payload = {
        "sender": {"name": nombre_remitente or "Stylo Barber", "email": remitente.strip()},
        "to": [{"email": to_email}],
        "subject": subject,
        "textContent": plain,
        "htmlContent": html_body,
    }
    req = urllib_request.Request(
        url="https://api.brevo.com/v3/smtp/email",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib_request.urlopen(req, timeout=timeout) as response:
            return 200 <= response.getcode() < 300
    except (urllib_error.HTTPError, urllib_error.URLError, TimeoutError, ValueError) as exc:
        logger.warning("Brevo API mail send failed: %s", exc)
        return False


def send_stylo_transactional(to_email: str, subject: str, plain: str, html_body: str) -> bool:
    """Prioridad: Brevo API (HTTPS) → SMTP de respaldo."""
    remitente = (
        getattr(settings, "BREVO_FROM_EMAIL", "")
        or getattr(settings, "DEFAULT_FROM_EMAIL", "no-reply@stylo.local")
    )
    nombre_remitente = (getattr(settings, "BREVO_FROM_NAME", "") or "Stylo Barber Connect").strip()
    brevo_timeout = int(getattr(settings, "BREVO_API_TIMEOUT_SECONDS", 15) or 15)

    if _send_brevo_api(
        to_email=to_email,
        subject=subject,
        plain=plain,
        html_body=html_body,
        remitente=remitente,
        nombre_remitente=nombre_remitente,
        timeout=brevo_timeout,
    ):
        return True

    try:
        from_header = formataddr((nombre_remitente, remitente.strip()))
        send_mail(subject, plain, from_header, [to_email], fail_silently=False, html_message=html_body)
        return True
    except Exception:
        logger.exception(
            "SMTP send_mail failed (2FA y otros correos). "
            "En Render plan gratuito SMTP (587) suele estar bloqueado: define BREVO_API_KEY (HTTPS). "
            "En local el SMTP de respaldo sí puede funcionar si EMAIL_HOST está configurado."
        )
        return False
