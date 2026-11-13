const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return respond({ error: 'Método no permitido.' }, 405);

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return respond({ error: 'El cuerpo de la solicitud debe ser JSON válido.' }, 400);
  }

  if (!isRecord(input)) return respond({ error: 'El cuerpo de la solicitud no es válido.' }, 400);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!title || !description || title.length > 200 || description.length > 4000) {
    return respond({ error: 'El título y la descripción son obligatorios y deben respetar sus límites.' }, 400);
  }

  const apiKey = Deno.env.get('GROQ_API_KEY');
  if (!apiKey) return respond({ error: 'El servicio de sugerencias no está configurado.' }, 500);

  let groqResponse: Response;
  try {
    groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Propón entre 3 y 8 subtareas accionables y concisas en español para completar el ticket. Usa solo información presente en el ticket; no inventes requisitos. Devuelve únicamente un objeto JSON con la forma {"subtasks":["..."]}. Cada subtarea debe ser una cadena de máximo 200 caracteres.'
          },
          {
            role: 'user',
            content: JSON.stringify({ title, description })
          }
        ]
      })
    });
  } catch {
    return respond({ error: 'No fue posible conectar con el proveedor de IA.' }, 502);
  }

  if (!groqResponse.ok) {
    return respond({ error: 'El proveedor de IA no pudo generar las subtareas.' }, 502);
  }

  let completion: { choices?: Array<{ message?: { content?: string } }> };
  try {
    completion = await groqResponse.json();
  } catch {
    return respond({ error: 'El proveedor de IA devolvió una respuesta inválida.' }, 502);
  }

  const content = completion.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    return respond({ error: 'El proveedor de IA no devolvió subtareas.' }, 502);
  }

  let generated: { subtasks?: unknown };
  try {
    generated = JSON.parse(content);
  } catch {
    return respond({ error: 'El proveedor de IA devolvió una lista inválida.' }, 502);
  }

  if (!Array.isArray(generated.subtasks)) {
    return respond({ error: 'El proveedor de IA devolvió una lista inválida.' }, 502);
  }

  const subtasks = generated.subtasks
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 10);
  return respond({ subtasks });
});
