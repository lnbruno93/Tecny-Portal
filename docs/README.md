# Índice de documentación — iPro Portal

Punto de entrada a todos los docs operativos del repo. Si llegás acá sin
contexto, arrancá por **ARCHITECTURE** y después saltá al doc que
corresponde a tu pregunta.

---

## Por dónde empezar

| Si querés... | Leé |
|---|---|
| **Entender de qué se trata el sistema** | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Resolver un problema en vivo | [RUNBOOK.md](RUNBOOK.md) |
| Hacer un deploy, backup, rollback | [OPERATIONS.md](OPERATIONS.md) |
| Saber qué se está monitoreando | [OBSERVABILITY.md](OBSERVABILITY.md) |
| Recuperar datos de un incidente | [DISASTER_RECOVERY.md](DISASTER_RECOVERY.md) |
| Medir performance / regresiones | [LOAD_BASELINE.md](LOAD_BASELINE.md) |
| Setear el entorno de staging | [STAGING.md](STAGING.md) |
| **Tocar config multi-env (netlify.toml, RLS, env vars)** — LEER ANTES | [MULTI_ENV_DRIFT.md](MULTI_ENV_DRIFT.md) |
| Escribir migration con `UPDATE`/backfill sobre tabla RLS | [RUNBOOK_MIGRATION_RLS_FORCE.md](RUNBOOK_MIGRATION_RLS_FORCE.md) |
| Resolver drift de owner en tablas RLS (7 tablas caso 07-25) | [RUNBOOK_RLS_OWNER_FIX.md](RUNBOOK_RLS_OWNER_FIX.md) |
| Llamar a la API directo | [API_REFERENCE.md](API_REFERENCE.md) |
| Saber cómo se gestionan archivos | [STORAGE.md](STORAGE.md) |
| Crear / prender / apagar un feature flag | [FEATURE_FLAGS.md](FEATURE_FLAGS.md) |

---

## Mapa mental

```
                ARCHITECTURE.md
                       │
            ┌──────────┼──────────┐
            │          │          │
    operación        ¿pasa algo?   referencia
            │          │          │
   OPERATIONS.md   RUNBOOK.md    API_REFERENCE.md
        │                            │
   DISASTER_RECOVERY.md          STORAGE.md
        │
   OBSERVABILITY.md
        │
   LOAD_BASELINE.md

                STAGING.md
        (setup entorno de pruebas)
                │
     MULTI_ENV_DRIFT.md ────────────┐
     (prevenir divergencia          │
      prod/staging/preview)         │
                                    ├─── RUNBOOK_MIGRATION_RLS_FORCE.md
                                    │    (fix migration + backfill sobre
                                    │     tabla FORCE RLS — incidente 08-01)
                                    │
                                    └─── RUNBOOK_RLS_OWNER_FIX.md
                                         (resolver drift owner en tablas
                                          RLS — incidente 07-25)
```

---

## Convenciones

- Todos los docs están en **español**. Lucas (product owner) trabaja en español.
- Los snippets de código y los nombres de columnas/tablas quedan en su idioma
  original (sin traducir).
- Los docs son **vivos**: si hacés un cambio que invalida algo escrito acá,
  actualizar es parte del PR.
- Decisiones durables se documentan en ARCHITECTURE §8 ("Decisiones durables
  y por qué"). Si algo cambia, agregar el nuevo razonamiento ahí — la
  decisión vieja se conserva como contexto histórico.
