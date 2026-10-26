import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Método no permitido.' }, 405);

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return jsonResponse({ error: 'Sesión requerida.' }, 401);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing Supabase function environment configuration.');
    return jsonResponse({ error: 'La función no está configurada correctamente.' }, 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const token = authorization.slice('Bearer '.length);
  const { data: authData, error: authError } = await adminClient.auth.getUser(token);
  if (authError || !authData.user) return jsonResponse({ error: 'Sesión inválida o vencida.' }, 401);

  const { data: callerProfile, error: profileError } = await adminClient
    .from('profiles')
    .select('role')
    .eq('id', authData.user.id)
    .maybeSingle();
  if (profileError) {
    console.error('Could not verify caller role:', profileError.message);
    return jsonResponse({ error: 'No fue posible verificar los permisos.' }, 500);
  }
  if (callerProfile?.role !== 'Admin') return jsonResponse({ error: 'Solo un administrador puede crear usuarios.' }, 403);

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return jsonResponse({ error: 'El cuerpo de la solicitud no es válido.' }, 400);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return jsonResponse({ error: 'El cuerpo de la solicitud no es válido.' }, 400);
  }

  const payload = input as Record<string, unknown>;
  const fullName = typeof payload.fullName === 'string' ? payload.fullName.trim() : '';
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const password = typeof payload.password === 'string' ? payload.password : '';
  const role = payload.role;
  if (fullName.length < 2 || fullName.length > 100) return jsonResponse({ error: 'El nombre no es válido.' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return jsonResponse({ error: 'El correo electrónico no es válido.' }, 400);
  }
  if (password.length < 12 || password.length > 128) {
    return jsonResponse({ error: 'La contraseña debe tener entre 12 y 128 caracteres.' }, 400);
  }
  if (!['Admin', 'Agent', 'Reporter'].includes(String(role))) {
    return jsonResponse({ error: 'El rol seleccionado no es válido.' }, 400);
  }

  const { data: created, error: createError } = await adminClient.auth.admin.createUser({
    email,
    password,
    email_confirm: false
  });
  if (createError || !created.user) {
    return jsonResponse({ error: createError?.message || 'No fue posible crear la cuenta.' }, 400);
  }

  const { error: insertError } = await adminClient.rpc('admin_create_user_workspace', {
    p_user_id: created.user.id,
    p_full_name: fullName,
    p_email: email,
    p_role: role,
    p_created_by_admin_id: authData.user.id
  });

  if (insertError) {
    const { error: deleteError } = await adminClient.auth.admin.deleteUser(created.user.id);
    if (deleteError) console.error('Could not roll back auth user creation:', deleteError.message);
    return jsonResponse({ error: insertError.message }, 400);
  }

  const { data: profile, error: selectError } = await adminClient
    .from('profiles')
    .select('id,full_name,email,role,workspace_id,created_by_admin_id')
    .eq('id', created.user.id)
    .single();
  if (selectError || !profile) {
    console.error('User profile was created but could not be retrieved:', selectError?.message);
    return jsonResponse({ error: 'La cuenta se creó, pero no se pudo recuperar su perfil.' }, 500);
  }

  return jsonResponse({
    id: profile.id,
    fullName: profile.full_name,
    email: profile.email,
    role: profile.role,
    workspaceId: profile.workspace_id,
    createdByAdminId: profile.created_by_admin_id
  }, 201);
});
