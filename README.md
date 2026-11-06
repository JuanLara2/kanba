# VortexTask (Kanba)

**Gestión de tickets para equipos con tablero Kanban, calendario y métricas.**

VortexTask es una aplicación web con interfaz adaptable y manifiesto PWA. Está construida con JavaScript nativo, HTML y CSS, y utiliza Supabase para autenticación, persistencia y sincronización en tiempo real.

## Contenido

- [Funciones](#funciones)
- [Tecnologías](#tecnologías)
- [Arquitectura](#arquitectura)
- [Requisitos](#requisitos)
- [Configuración de Supabase](#configuración-de-supabase)
- [Ejecución local](#ejecución-local)
- [Pruebas](#pruebas)
- [Despliegue](#despliegue)
- [Seguridad](#seguridad)
- [Licencia](#licencia)

## Funciones

- Tablero Kanban para organizar tickets por estado.
- Calendario mensual para consultar y reprogramar fechas límite.
- Vista rápida de subtareas desde las tarjetas del calendario.
- Métricas operativas, indicadores de SLA y exportación CSV.
- Autenticación y permisos por rol: Admin, Agent y Reporter.
- Comentarios, notificaciones y actualizaciones en tiempo real.
- Cola local de cambios pendientes en IndexedDB, con reintento al recuperar la conexión.
- Interfaz adaptable, áreas seguras para dispositivos móviles y soporte progresivo para View Transitions y vibración háptica.

> La cola local conserva cambios pendientes, pero la aplicación no implementa caché offline del App Shell ni un service worker.

## Tecnologías

| Área | Implementación |
| --- | --- |
| Interfaz | JavaScript ES modules, HTML y CSS propio |
| Backend | Supabase Auth, PostgreSQL, PostgREST y Realtime |
| Acceso a datos | Cliente Supabase y adaptador REST del proyecto |
| Persistencia local | IndexedDB para la cola de mutaciones |
| Gráficas | SVG nativo |
| Pruebas | Node.js y `node:test` |

El proyecto no utiliza Tailwind CSS ni Chart.js actualmente.

## Arquitectura

```text
┌────────────────────── Navegador / PWA ───────────────────────┐
│                                                              │
│  Tablero · Calendario · Métricas · Modales                   │
│                         │                                    │
│       Estado optimista · Servicios · MutationDispatcher      │
│                    ┌────┴─────┐                              │
│                    │          │                              │
│             IndexedDB       Cliente REST / Realtime           │
└───────────────────────────────────┬──────────────────────────┘
                                    │
                    Supabase Auth · PostgreSQL · RLS
```

Los cambios compatibles con la cola offline se aplican de forma optimista y se guardan en IndexedDB para intentar sincronizarlos cuando vuelva la conexión. La autorización y el aislamiento de datos deben validarse también en Supabase mediante RLS.

## Requisitos

- Node.js 20 o posterior para las pruebas y validaciones.
- Un proyecto Supabase configurado con el esquema y las migraciones del repositorio.
- Un servidor HTTP local para servir el frontend. No abras `index.html` directamente como archivo.

## Configuración de Supabase

1. Crea un proyecto Supabase.
2. En **SQL Editor**, ejecuta [`supabase/schema.sql`](./supabase/schema.sql).
3. Aplica las migraciones de [`supabase/migrations/`](./supabase/migrations/) en orden cronológico por nombre. Lleva un registro de las migraciones ya ejecutadas.
4. Configura la URL y la clave pública/publishable del proyecto en [`js/config/supabase.js`](./js/config/supabase.js):

   ```js
   export const SUPABASE_URL = 'https://your-project.supabase.co';
   export const SUPABASE_ANON_KEY = 'your-publishable-key';
   ```

5. Despliega la función de Supabase para la creación de usuarios:

   ```bash
   supabase functions deploy admin-create-user
   ```

6. Configura el primer perfil Admin mediante un procedimiento de aprovisionamiento confiable. La función `admin-create-user` requiere que quien la invoque ya tenga el rol Admin; por eso no crea por sí sola el primer administrador.

> La URL y la clave publishable/anon se usan en el cliente y no son secretos. Nunca incluyas una clave `service_role` en el frontend ni en el repositorio. Mantén las claves privilegiadas en secretos del entorno de Supabase.

## Ejecución local

Desde la raíz del repositorio, inicia un servidor estático. Por ejemplo:

```bash
# Python
python -m http.server 5500

# En Windows, si el comando anterior no está disponible
py -m http.server 5500
```

Abre <http://localhost:5500> en el navegador. También puedes usar otro servidor estático compatible con módulos ES.

## Pruebas

```bash
npm ci
npm test
npm run check
```

- `npm test` ejecuta la suite de pruebas automatizadas.
- `npm run check` comprueba la sintaxis de `js/app.js`.

## Despliegue

El workflow [`deploy-pages.yml`](./.github/workflows/deploy-pages.yml) ejecuta las pruebas y la comprobación de sintaxis; luego publica el sitio en GitHub Pages cuando hay cambios en `main`.

En GitHub, configura **Settings → Pages → Build and deployment → GitHub Actions**. Verifica que `js/config/supabase.js` apunte al proyecto Supabase correspondiente al entorno publicado.

## Seguridad

- Row Level Security (RLS) debe estar habilitado y configurado en Supabase; ocultar o deshabilitar controles en la interfaz no sustituye la autorización del servidor.
- La función `admin-create-user` usa la clave de servicio en el entorno de Supabase y verifica la identidad y el rol del usuario que la invoca.
- Revisa el esquema y las migraciones antes de aplicarlos en producción.

## Licencia

El repositorio no incluye actualmente un archivo de licencia. No se debe asumir una licencia de uso o redistribución hasta que se publique una.
