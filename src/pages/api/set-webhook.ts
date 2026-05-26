import type { APIRoute } from 'astro';

function getEnv(context: Record<string, unknown>, key: string): string {
  const locals = context.locals as Record<string, unknown> | undefined;
  const runtime = locals?.runtime as Record<string, unknown> | undefined;
  const env = runtime?.env as Record<string, string> | undefined;

  if (env?.[key]) {
    return env[key];
  }
  if (import.meta.env?.[key]) {
    return import.meta.env[key];
  }
  const g = globalThis as Record<string, unknown>;
  const processObj = g.process as Record<string, Record<string, string>> | undefined;
  if (processObj?.env?.[key]) {
    return processObj.env[key];
  }
  return '';
}

export const POST: APIRoute = async (context) => {
  const TELEGRAM_BOT_TOKEN = getEnv(context, 'TELEGRAM_BOT_TOKEN');

  try {
    const body = await context.request.json();
    let { url } = body;

    if (!TELEGRAM_BOT_TOKEN) {
      return new Response(JSON.stringify({ error: 'TELEGRAM_BOT_TOKEN no está configurado en el servidor.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!url || typeof url !== 'string' || url.trim() === '') {
      return new Response(JSON.stringify({ error: 'La URL pública del webhook es requerida.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    url = url.trim();
    if (!url.endsWith('/api/webhook') && !url.endsWith('/api/webhook/')) {
      url = url.replace(/\/$/, '') + '/api/webhook';
    }

    console.log(`Configurando Webhook de Telegram para apuntar a: ${url}`);

    const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${url}`;
    const response = await fetch(telegramUrl);
    const data = await response.json();

    if (response.ok && data.ok) {
      return new Response(JSON.stringify({
        success: true,
        message: data.description || 'Webhook configurado exitosamente.',
        telegramResponse: data
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      return new Response(JSON.stringify({
        success: false,
        error: data.description || 'Error de Telegram al configurar el webhook.',
        telegramResponse: data
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (err) {
    const error = err as Error;
    console.error("Error al configurar el Webhook:", error);
    return new Response(JSON.stringify({ error: error.message || 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
