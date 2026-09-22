# Catálogo de instituciones y verificación institucional

Dos productos distintos:

- **Catálogo** (`data/catalog.json`): qué instituciones y campus existen. Sale de datasets oficiales.
- **Dominios verificables** (`data/email-domains.json`): qué dominios de correo prueban afiliación vigente. Sale de páginas oficiales de cada institución. Que una institución exista no significa que su dominio verifique.

## Flujo

```bash
node scripts/import-institutions/fetch-sources.mjs          # baja SEP 911, SNIES e IPEDS a raw/ (no se versiona)
node scripts/import-institutions/build-catalog.mjs          # raw/ + data/overrides.json -> data/catalog.json
node scripts/import-institutions/import.mjs --dry-run       # reporte inserted/updated/unchanged/conflicted/skipped
node scripts/import-institutions/import.mjs                 # escribe supabase/migrations/20260917010000_catalogo-instituciones-datos.sql
npm run schema:gen
```

`--dry-run` compara contra `data/production-snapshot.json`. Para compararlo con la base real, ejecuta en el SQL Editor lo que imprime `import.mjs --print-snapshot-sql`, guarda el JSON y pásalo con `--snapshot ruta.json`.

El importador termina con error si:
- un slug conocido de producción apuntaría a otro id,
- un campus cambiaría de institución,
- hay slugs, nombres, fuentes o dominios duplicados,
- un dominio pretende verificar sin estar `confirmed`, con fuente oficial, activo y con audiencia `student` o `all_affiliates`.

La migración generada nunca borra, no toca `profiles` ni `events` y comprueba al final que ningún perfil ni evento cambió de campus.

## Fuentes y criterios

| País | Fuente | Criterio |
|---|---|---|
| MX | SEP, formato 911 educación superior escolarizada 2023-2024 (datos.gob.mx) | Autónomas con 2,000+ estudiantes; por estado, 2 públicas y 2 privadas con más matrícula; las que ya existían. Sin normales ni unidades UPN. Claves de una misma institución en varios estados = campus. |
| CO | MEN, Instituciones de Educación Superior del SNIES (datos.gov.co n5yy-8nav) | Todas las universidades y las IES con acreditación de alta calidad; seccionales = campus. Sin escuelas militares o policiales. |
| US | NCES, IPEDS HD2023 | Por estado: 2 públicas de 4 años, 1 privada sin fines de lucro de 4 años y 1 community college público, por tamaño IPEDS, luego Carnegie R1/R2 y land-grant. |
| CO (escuela) | MEN, Establecimientos educativos (DANE 376001001221) | Colegio Bolívar, tipo `school`. |

Se usó IPEDS y no la API de College Scorecard porque la clave de demostración se agota en pocas peticiones.

## Dominios: cómo añadir o habilitar uno

1. Encontrar una página **en el dominio oficial de la institución** que diga a quién se entrega el correo.
2. Si incluye egresados, o no dice si es para estudiantes vigentes, dejarlo `verification_enabled: false`.
3. Anotar `official_source_url`, `source_title`, `last_verified_at` y `notes`.
4. Regenerar la migración con `import.mjs`.

Estado al 2026-09-14: verifican `tec.mx`, `fsu.edu`, `purdue.edu`, `comunidad.unam.mx`, `alumnos.udg.mx` y `uanl.edu.mx`. `tec.mx` se apoya en Conecta Tec (2021), que exige @tec.mx a estudiantes, profesores y colaboradores y deja fuera a los EXATEC; conviene buscar una fuente más reciente. `exatec.tec.mx` es de egresados.

## Configuración manual pendiente

- **Supabase SQL Editor**: aplicar `20260917000000_verificacion-institucional.sql` y después `20260917010000_catalogo-instituciones-datos.sql`.
- **Edge Function** `institution-verification`: desplegarla y definir los secretos de UNO de estos envíos (se usa el primero completo):
  - **Resend** (con dominio propio): `RESEND_API_KEY` y `VERIFICATION_EMAIL_FROM` (remitente con dominio verificado, SPF y DKIM).
  - **Gmail por SMTP** (provisional desde 2026-09-15, sin dominio): `SMTP_USER` (la cuenta) y `SMTP_PASSWORD` (contraseña de aplicación de Google, requiere verificación en dos pasos). Sale por el puerto 465; Gmail limita a unos 500 correos al día.
  - Siempre: `VERIFICATION_IP_SALT`.
  Sin un envío completo la función responde `EMAIL_NOT_CONFIGURED` y no crea desafíos.
- Los códigos nunca se envían a direcciones de relay de Apple (se rechazan antes), así que no hace falta registrar el remitente en el servicio de relay privado de Apple para este flujo.
