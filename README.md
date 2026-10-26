# NexusDesk Kanban

Aplicación de tickets con frontend Vanilla JavaScript y backend Supabase (Auth, Postgres y Row Level Security).

## Preparar Supabase

1. Crea un proyecto Supabase y abre **SQL Editor**.
2. Ejecuta el contenido de [`supabase/schema.sql`](./supabase/schema.sql).
3. En **Authentication → Users**, crea la primera cuenta administradora y confirma su correo.
4. Ejecuta en SQL Editor el siguiente comando, sustituyendo el correo y nombre:

   ```sql
   insert into public.profiles (id, full_name, email, role)
   select id, 'Nombre del administrador', email, 'Admin'
   from auth.users
   where lower(email) = lower('admin@tu-dominio.com')
   on conflict (id) do nothing;
   ```

   El rol inicial solo se asigna desde el entorno de administración de Supabase. Después, la creación de cuentas y perfiles se hace mediante la función protegida.

## Configurar el frontend

En [`js/config/supabase.js`](./js/config/supabase.js), configura la URL del proyecto y su clave **publishable/anon**:

```js
export const SUPABASE_URL = 'https://<project-ref>.supabase.co';
export const SUPABASE_ANON_KEY = '<publishable-or-anon-key>';
```

La clave publishable/anon puede estar en el navegador porque los datos están protegidos con RLS. **Nunca pongas la clave `service_role` en el frontend ni en este archivo.**

Sirve la carpeta del proyecto desde un servidor HTTP local (por ejemplo, Live Server); no abras `index.html` con `file://`, porque el navegador no permite correctamente los módulos y solicitudes de red bajo ese esquema.

## Desplegar la función de administración

Instala e inicia sesión en Supabase CLI, vincula el proyecto y despliega la función:

```powershell
supabase login
supabase link --project-ref <project-ref>
supabase functions deploy admin-create-user
```

La función usa `SUPABASE_SERVICE_ROLE_KEY` solo en el entorno aislado de Supabase y verifica el JWT y el perfil Admin del solicitante. No se requiere copiar ni exponer esa clave en el navegador.

## Publicar en GitHub Pages

El workflow [deploy-pages.yml](./.github/workflows/deploy-pages.yml) ejecuta las pruebas y publica los archivos estáticos al hacer push a `main`.

1. En el repositorio GitHub, abre **Settings → Pages** y selecciona **GitHub Actions** como fuente del despliegue.
2. Publica el proyecto en la rama `main`. El workflow construye el sitio estático y despliega NexusDesk en `https://juanlara2.github.io/kanba/`.
3. En Supabase, abre **Authentication → URL Configuration** y agrega `https://juanlara2.github.io/kanba/` a **Redirect URLs**.

La URL y la clave `publishable/anon` del frontend son visibles para los visitantes del sitio; la seguridad depende de RLS. La clave `service_role` nunca debe publicarse. Esta versión está conectada al proyecto Supabase configurado para la app: quienes tengan cuentas válidas compartirán sus datos y cambios. No compartas el sitio con testers externos si no quieres que accedan a los datos de ese proyecto.

## Notas

- Las cuentas y los tickets ya no se crean desde datos semilla locales. El primer Admin se aprovisiona desde Supabase; los demás usuarios se crean desde **Administrar usuarios**.
- Los cambios de estado se registran en `ticket_status_history` mediante un trigger de PostgreSQL. El frontend no puede escribir ni modificar directamente ese historial.
- Las políticas RLS y el trigger del esquema son la autoridad para permisos; los controles de interfaz y las validaciones JavaScript solo mejoran la experiencia.
- Las pruebas unitarias se ejecutan con `npm.cmd test`; las comprobaciones de sintaxis con `npm.cmd run check`.
