# Entrenos de Juli

App web para el celular: rutina del mes, registro de series (reps y kg), historial y gráficos de progreso. Dos usuarios: la atleta anota los entrenos y la entrenadora los ve, comenta y carga rutinas nuevas. Se instala en la pantalla de inicio como una app.

Node 20+ · Express · Postgres. Sin build: `npm start` y listo.

## Deploy en Railway

1. Subí esta carpeta a un repo de GitHub (privado está bien).
2. En Railway: **New Project → Deploy from GitHub repo** y elegí el repo.
3. En el mismo proyecto: **+ New → Database → PostgreSQL**.
4. En el servicio de la app, pestaña **Variables**, agregá:

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (referencia al Postgres) |
   | `SESSION_SECRET` | un texto largo y aleatorio (p. ej. 40 caracteres) |
   | `NODE_ENV` | `production` |
   | `ATHLETE_EMAIL` / `ATHLETE_PASSWORD` | tu login |
   | `ATHLETE_NAME` | `Juli` |
   | `COACH_EMAIL` / `COACH_PASSWORD` | el login de tu entrenadora |
   | `COACH_NAME` | su nombre |
   | `OPENROUTER_API_KEY` | opcional: para pegar la rutina de WhatsApp y que se cargue sola |
   | `OPENROUTER_MODEL` | opcional, por defecto `anthropic/claude-sonnet-5.5` |

5. **Settings → Networking → Generate Domain** para tener la URL pública.

Al arrancar por primera vez crea las tablas, los dos usuarios, la rutina del mes 5 y el entreno del lunes 12/10 que ya tenías anotado. Cada uno puede cambiar su contraseña desde el círculo con la inicial (arriba a la derecha). Si alguien se la olvida: cambiá la variable, poné `RESET_PASSWORDS=1`, redeploy, y después borrá esa variable.

## Instalar en el celular

- **iPhone (Safari):** abrir la URL → botón Compartir → *Agregar a pantalla de inicio*.
- **Android (Chrome):** abrir la URL → menú ⋮ → *Instalar app* / *Agregar a pantalla principal*.

La sesión dura 4 meses, así que se abre directo.

## Cómo se usa

**Entrenar** (atleta): elige el día según la fecha (lunes/miércoles/viernes). Cada ejercicio muestra lo que pidió la entrenadora, cómo se hace y lo que hiciste la última vez (también como sugerencia gris en cada casillero). Se guarda solo mientras escribís; si no hay señal en el gym, queda en el celular y se sube cuando vuelve la conexión. Para corregir un día pasado, cambiá la fecha o tocá *Editar* en Historial.

**Progreso:** por ejercicio, el peso máximo de cada día y cuánto subió desde el primer registro. Un ejercicio mantiene su historial entre rutinas si se llama igual.

**Historial:** cada entreno con sus series. La entrenadora puede dejar un comentario, que aparece en el entreno.

**Rutinas:** la vigente y las anteriores. *Nueva rutina* permite pegar el mensaje de WhatsApp (con `OPENROUTER_API_KEY`), duplicar la vigente o empezar en blanco; siempre se revisa en el editor antes de guardar. Pueden cargarla tanto la atleta como la entrenadora.

## Local

```bash
npm install
DATABASE_URL=postgres://... SESSION_SECRET=algo ATHLETE_EMAIL=... ATHLETE_PASSWORD=... COACH_EMAIL=... COACH_PASSWORD=... npm start
```

Si tu Postgres pide SSL con certificado propio, agregá `PGSSL=1`.
