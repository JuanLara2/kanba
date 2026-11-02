# Vortex Task

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
5. Ejecuta las migraciones de `supabase/migrations/` en orden para activar el aislamiento de equipos, las listas de subtareas, SLA, comentarios, notificaciones, categorías, plantillas compartidas, encuestas de satisfacción, Supabase Realtime y los adjuntos privados de tickets. La migración de SLA requiere la extensión `pg_cron`, disponible en Supabase, para generar avisos aunque nadie tenga abierta la aplicación.

Si el proyecto ya tiene `schema.sql` y el perfil Admin configurados, vincula Supabase CLI al proyecto y ejecuta las migraciones pendientes en orden con `npx.cmd supabase db push --linked`; no vuelvas a ejecutar el esquema base. Este comando aplica, entre otras, las migraciones de SLA y colaboración, categorías, métricas, plantillas, satisfacción, Realtime y adjuntos.

## Configurar el frontend

En [`js/config/supabase.js`](./js/config/supabase.js), configura la URL del proyecto y su clave **publishable/anon**:

```js
export const SUPABASE_URL = 'https://<project-ref>.supabase.co';
export const SUPABASE_ANON_KEY = '<publishable-or-anon-key>';
```

La clave publishable/anon puede estar en el navegador porque los datos están protegidos con RLS. **Nunca pongas la clave `service_role` en el frontend ni en este archivo.**

### Adjuntos de tickets

Aplica la migración `20261101000000_ticket_attachments.sql` en Supabase antes de habilitar los adjuntos en producción (`npx.cmd supabase db push --linked`). La migración crea el bucket privado `ticket-attachments`, las políticas RLS de Storage y la tabla `ticket_attachments` para asociar metadatos de archivos con un ticket y, opcionalmente, un comentario. Las rutas siguen el formato `workspace_id/ticket_id/archivo`; tanto la política de objetos como la tabla verifican el espacio de trabajo y los permisos aplicables al ticket. Las imágenes se sirven mediante enlaces firmados con vencimiento, nunca con un bucket público.

El frontend acepta JPG, PNG, WebP y GIF, con un máximo de cinco imágenes por comentario y 8 MB por archivo. JPEG/PNG/WebP se intentan convertir a WebP con calidad moderada y un lado máximo de 1920 px; los GIF se conservan para no perder la animación. Si Storage o la sesión no están disponibles, se informa el error. La publicación del comentario y el almacenamiento no forman una transacción atómica; el cliente intenta limpiar cargas parciales y avisa si no logra vincular un adjunto al comentario.

Sirve la carpeta del proyecto desde un servidor HTTP local (por ejemplo, Live Server); no abras `index.html` con `file://`, porque el navegador no permite correctamente los módulos y solicitudes de red bajo ese esquema.

## Desplegar la función de administración

Instala e inicia sesión en Supabase CLI, vincula el proyecto y despliega la función:

```powershell
supabase login
supabase link --project-ref <project-ref>
supabase functions deploy admin-create-user
```

La función usa `SUPABASE_SERVICE_ROLE_KEY` solo en el entorno aislado de Supabase y verifica el JWT y el perfil Admin del solicitante. No se requiere copiar ni exponer esa clave en el navegador. Despliégala después de las migraciones; las nuevas cuentas creadas por un Admin se unirán al espacio de ese equipo.

## Recuperación y cambio de contraseña

Los usuarios pueden cambiar su contraseña desde la sesión iniciada o solicitar un enlace desde el inicio de sesión. Para que el enlace regrese a GitHub Pages, agrega `https://juanlara2.github.io/kanba/` en **Authentication → URL Configuration → Redirect URLs** de Supabase.

El SMTP predeterminado de Supabase sirve para pruebas: actualmente limita el envío a 2 correos por hora y solo entrega a direcciones autorizadas del equipo del proyecto. Para enviar enlaces a todos los usuarios, configura un proveedor SMTP externo en **Authentication → SMTP Settings**. El costo del correo depende del proveedor elegido.

## Publicar en GitHub Pages

El workflow [deploy-pages.yml](./.github/workflows/deploy-pages.yml) ejecuta las pruebas y publica los archivos estáticos al hacer push a `main`.

1. En el repositorio GitHub, abre **Settings → Pages** y selecciona **GitHub Actions** como fuente del despliegue.
2. En **Settings → Pages → Custom domain**, escribe `juanlaraportafolio.website`, guarda y espera a que GitHub verifique el DNS y habilite HTTPS. El workflow incluye el archivo `CNAME` en cada despliegue para conservar el dominio.
3. En Hostinger, los cuatro registros A del dominio raíz deben apuntar a `185.199.108.153`, `185.199.109.153`, `185.199.110.153` y `185.199.111.153`. Esos registros ya responden con las direcciones de GitHub Pages; no los dupliques si ya están configurados.
4. En Supabase, abre **Authentication → URL Configuration**, establece `https://juanlaraportafolio.website` como **Site URL** y agrégalo a **Redirect URLs**. Conserva la URL de GitHub Pages en la lista mientras verificas el dominio nuevo.

La URL y la clave `publishable/anon` del frontend son visibles para los visitantes del sitio; la seguridad depende de RLS. La clave `service_role` nunca debe publicarse. Esta versión está conectada al proyecto Supabase configurado para la app: quienes tengan cuentas válidas compartirán sus datos y cambios. No compartas el sitio con testers externos si no quieres que accedan a los datos de ese proyecto.

## Experiencia móvil

La interfaz móvil incorpora un botón flotante para crear tickets, navegación inferior entre Tablero, Calendario y Métricas, y un selector horizontal de estados que muestra el total de tickets y presenta una sola columna a la vez. Se puede deslizar horizontalmente sobre el tablero para cambiar de estado/columna, tirar hacia abajo al inicio para sincronizar, y desplazarse para ocultar o recuperar la cabecera. En las tarjetas, deslizar a la derecha intenta resolver y deslizar a la izquierda abre acciones rápidas para prioridad, responsable o eliminación, siempre según los permisos del usuario; la eliminación requiere confirmación y solo está disponible para Admin. Una pulsación larga de 400 ms activa la selección múltiple: se pueden mover, reasignar o cerrar tickets seleccionados. Cerrar conserva los tickets; las operaciones por lote informan los cambios parciales si algún permiso o petición falla. La búsqueda ocupa una pantalla enfocada con filtros rápidos e historial de la sesión; los filtros activos se muestran como chips. El botón Atrás del dispositivo cierra primero los paneles abiertos y tocar la pestaña activa vuelve al inicio. Las tarjetas ofrecen un menú táctil para cambiar de estado según los permisos del usuario, y los filtros avanzados se agrupan en una hoja inferior.

El manifiesto PWA declara accesos directos para crear un ticket o ver los urgentes; la disponibilidad de estos accesos depende del navegador y del sistema operativo. Las acciones táctiles compatibles dan una vibración breve cuando el dispositivo permite háptica. El calendario permite desplazarse para consultar sus días y los formularios se adaptan al alto de la pantalla.

El sitio incluye un manifiesto con iconos de 192 × 192 y 512 × 512 px para Android, además de un icono Apple Touch de 180 × 180 px para iOS. En el teléfono, abre el sitio y usa **Añadir a pantalla de inicio** desde el menú del navegador.

## Notas

- **Resiliencia offline (Fase 1):** los cambios de estado por arrastrar y soltar y las conmutaciones de subtareas se reflejan primero en la interfaz. Si el navegador está desconectado, quedan en IndexedDB y se reproducen en orden al volver `online` o reconectarse Supabase Realtime. Las acciones contienen solo el tipo, el ticket y el cambio solicitado; quedan aisladas por usuario y espacio de trabajo, sin guardar tokens. Las escrituras siguen pasando por Supabase y RLS: un rechazo revierte la interfaz y muestra un aviso.
- La base IndexedDB `vortex-task` contiene `outbox` (clave `id`, índice compuesto `userId + workspaceId + sequence`, y campos `schemaVersion`, `type`, `entityId`, `payload` y `createdAt`) y `metadata` (clave `id`, valor del último `updated_at` sincronizado por espacio y usuario). `sequence` conserva el orden aunque el reloj retroceda o varias acciones se creen en el mismo milisegundo. El payload incluye el valor anterior necesario para revertir un rechazo; en subtareas solo se persiste el índice, texto y estado afectado. Los cambios pendientes se despachan secuencialmente; una caída de red conserva la acción, mientras un rechazo definitivo la descarta y recarga el estado autorizado.
- Al recuperar Realtime, la aplicación consulta `tickets.updated_at > last_sync` y combina los cambios con el tablero local. También obtiene los identificadores visibles bajo RLS para quitar tickets eliminados durante la desconexión, ya que el esquema actual no mantiene tombstones de eliminación. El navegador debe haber cargado previamente el tablero y conservar una sesión válida para que el usuario pueda seguir trabajando offline.
- Las cuentas y los tickets ya no se crean desde datos semilla locales. El primer Admin se aprovisiona desde Supabase; los demás usuarios se crean desde **Administrar usuarios**.
- Los cambios de estado se registran en `ticket_status_history` mediante un trigger de PostgreSQL. El frontend no puede escribir ni modificar directamente ese historial.
- Cada equipo tiene un espacio compartido: los Admins pueden asignar tickets a los Agent y Reporter creados para su equipo, y esos miembros ven los tickets del espacio según sus roles. Otros espacios siguen aislados por RLS. Los tickets existentes e historiales se conservan; las asignaciones que cruzaban espacios se quitaron durante la primera migración.
- La vista **Calendario** agrupa tickets por fecha límite en una cuadrícula mensual; Admin y Agent pueden arrastrarlos a otro día para reprogramarlos o a **Sin fecha** para quitar el plazo. Los filtros del tablero también se aplican al calendario.
- Cada ticket puede tener hasta 100 subtareas con su propio progreso. Admin y Agent con permiso para editar el ticket pueden añadir, completar y quitar subtareas; el avance aparece en la tarjeta y en el calendario, y la barra cambia de color según el porcentaje completado.
- Categorías disponibles: Soporte técnico, Accesos, Incidente, Solicitud de servicio, Consulta, Mejora y Nómina y Pagos. Se asignan desde los formularios y se pueden filtrar en el tablero.
- La vista **Métricas** permite elegir un periodo y consultar tickets creados y resueltos, tickets activos, cumplimiento SLA, tiempo promedio de resolución, satisfacción promedio y carga actual/resoluciones por Admin/Agent. Se exporta a CSV.
- Los cambios de tickets, comentarios y notificaciones se sincronizan mediante Supabase Realtime entre usuarios conectados. El indicador **En vivo** muestra el estado de conexión y la aplicación intenta reconectarse automáticamente.
- Las plantillas de respuesta son compartidas por espacio. Admin puede crearlas, editarlas y eliminarlas; Admin y Agent pueden insertarlas en comentarios.
- Admin o el Agent asignado pueden reabrir tickets Resueltos; regresan al estado Abierto y el cambio queda en el historial. Al cerrar un ticket, se notifica al Reporter que lo creó para que valore la atención de 1 a 5 estrellas y añada un comentario opcional; se registra una sola encuesta por ticket.
- La X y el botón Cancelar del diálogo de ticket lo cierran sin guardar los cambios pendientes. Para persistir las modificaciones se debe usar Guardar.
- El SLA de resolución empieza al crear el ticket: Urgente vence en 4 horas corridas; Alta en 8 horas hábiles; Media en 48 horas hábiles; Baja en 45 horas hábiles (5 días de 9 horas). El horario hábil es de lunes a viernes, 08:00–17:00 America/Bogota; no se descuentan festivos. El aviso de riesgo se emite al completar el 80% del tiempo objetivo. Los tickets resueltos o cerrados dejan de computar. El campo **Fecha límite** del calendario sigue siendo independiente del SLA.
- El tablero muestra totales de tickets activos, SLA próximos a vencer y vencidos; las tarjetas y el filtro SLA muestran el estado del objetivo de resolución. Una tarea `pg_cron` evalúa los vencimientos cada minuto y genera notificaciones para el creador y responsable; al vencer, también alerta a los Admin del espacio de trabajo.
- Cada ticket tiene una conversación persistente. Admin y Agent del espacio pueden leer y comentar; Reporter solo puede hacerlo en los tickets que creó. Al publicarse un comentario, se notifica al creador y responsable distintos del autor. Las notificaciones se consultan desde **Avisos**, se pueden abrir para ir al ticket y se marcan como leídas al abrirlas. La autorización se aplica en PostgreSQL mediante RLS.
- Si Supabase rechaza un refresh token guardado, la aplicación elimina esa sesión local y vuelve al inicio de sesión. Los avisos de acceso se muestran sobre la pantalla de login; si el token quedó inválido antes de esta actualización, recarga la página y vuelve a iniciar sesión.
- Los eventos del tablero validan el objetivo de los eventos delegados de arrastrar, soltar y clic antes de buscar tarjetas o columnas, evitando errores cuando el objetivo no es un elemento HTML.
- Las políticas RLS y el trigger del esquema son la autoridad para permisos; los controles de interfaz y las validaciones JavaScript solo mejoran la experiencia.
- El tema visual se puede cambiar entre oscuro, claro y rosa desde el encabezado; la preferencia queda guardada en el navegador.
- Las pruebas unitarias se ejecutan con `npm.cmd test`; las comprobaciones de sintaxis con `npm.cmd run check`.
