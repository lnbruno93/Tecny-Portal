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
