# Entorno de Staging (para testers)

Guía para montar un entorno **público y aislado** donde otras personas puedan probar y sugerir mejoras, **sin tocar producción ni los datos reales**.

## Arquitectura

```
                 PRODUCCIÓN                          STAGING (testers)
  Netlify (main)  ─────────────┐        Netlify (branch "staging") ──────────┐
   VITE_API_URL = prod backend │         VITE_API_URL = staging backend       │
                               ▼                                              ▼
  Railway backend (main) ──► Postgres ipro_portal      Railway backend (staging) ──► Postgres ipro_staging
        (DATOS REALES)                                        (DATOS DE PRUEBA)
```

Regla de oro: **staging usa su propia base de datos**. Nunca apunta a la base de producción.

---

## 1) Rama de staging

Creá una rama estable que vas a usar para testers (mergeás ahí lo que quieras probar):

```bash
git checkout main
git checkout -b staging
git merge feat/ventas-inventario   # traer los módulos nuevos
git push -u origin staging
```

> Más adelante, para probar algo nuevo: mergeás esa feature a `staging` y se redeploya solo.

---

## 2) Backend de staging en Railway

1. En tu proyecto de Railway → **New** → **Database → PostgreSQL**. Nombralo `ipro-staging-db`. (Es una base nueva, separada de producción.)
2. **New** → **GitHub Repo** → elegí `iPro-Portal`. Configurá el servicio:
   - **Root Directory:** `backend`
   - **Branch:** `staging`
   - **Start Command:** `npm run migrate && node server.js` (igual que prod; corre las migraciones solas).
3. **Variables** del servicio de staging:
   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | referenciá la base `ipro-staging-db` (Railway la inyecta con `${{ ipro-staging-db.DATABASE_URL }}`) |
   | `JWT_SECRET` | uno NUEVO y distinto de prod → generá con `openssl rand -hex 32` |
   | `JWT_EXPIRES_IN` | `8h` |
   | `NODE_ENV` | `production` |
   | `CORS_ORIGIN` | la URL de Netlify de staging (paso 3), ej. `https://staging--TUSITIO.netlify.app` |
4. Deployá. En el primer arranque corren las migraciones (incluidas las nuevas `20260524*`) y se crean todas las tablas.
5. Anotá la **URL pública** del backend de staging (ej. `https://ipro-staging.up.railway.app`).

---

## 3) Frontend de staging en Netlify

1. Netlify → tu sitio → **Site configuration → Build & deploy → Branches and deploy contexts** → habilitá el deploy de la rama **`staging`**.
2. **Environment variables** → agregá una variable con alcance al contexto de esa rama:
   - Key: `VITE_API_URL`
   - Value: la URL del backend de staging (paso 2.5)
   - Scope/Context: **Branch deploys → `staging`** (NO "Production" — así no afecta prod).
3. Disparás un deploy de la rama `staging`. Netlify te da una URL tipo `https://staging--TUSITIO.netlify.app`.
4. Volvé a Railway y asegurate de que `CORS_ORIGIN` del backend de staging contenga **exactamente** esa URL.

> Alternativa por archivo (opcional): en `netlify.toml` se puede fijar la env del contexto de rama:
> ```toml
> [context."staging".environment]
>   VITE_API_URL = "https://ipro-staging.up.railway.app"
> ```

---

## 4) Usuario demo en la base de staging

Las migraciones crean las tablas pero no usuarios. Creá un admin de prueba (corré esto **una vez**, apuntando a la DB de staging):

```bash
cd backend
DATABASE_URL="postgresql://...staging..." node -e "
const {Pool}=require('pg'); const bcrypt=require('bcrypt');
(async()=>{
  const pool=new Pool({connectionString:process.env.DATABASE_URL});
  const hash=await bcrypt.hash('CAMBIAR_ESTE_PASS',10);
  const r=await pool.query(\"INSERT INTO users (nombre,username,password_hash,role) VALUES ('Demo iPro','demo',\$1,'admin') ON CONFLICT (username) DO NOTHING RETURNING id\",[hash]);
  console.log(r.rows[0]?'admin demo creado':'ya existía');
  await pool.end();
})();
"
```

- Como es `admin`, ve todos los módulos automáticamente.
- Para testers con rol `op`, crealos desde la pantalla **Usuarios** del portal de staging y tildá los permisos (incluidos **Inventario** y **Ventas**).

---

## 5) Datos de ejemplo (opcional)

Para que los testers vean algo cargado, podés cargar productos/ventas a mano desde la UI, o pedirme un script de seed para staging.

---

## Checklist de verificación

- [ ] El backend de staging responde: `GET https://...staging.../health` → `{ status: "ok" }`.
- [ ] La URL de Netlify de staging carga el login.
- [ ] Login con el usuario demo funciona (si falla con error de red → revisar `CORS_ORIGIN` y `VITE_API_URL`).
- [ ] Se ven Inventario y Ventas en el menú.
- [ ] La base es `ipro_staging`, NO `ipro_portal` (verificá el `DATABASE_URL` del servicio de staging).

## Seguridad

- Staging **nunca** debe apuntar a la base de producción.
- No cargues datos reales de clientes en staging.
- `JWT_SECRET` de staging distinto al de producción.
- Cuando termine el testeo, podés pausar el servicio de Railway de staging para no gastar recursos.
