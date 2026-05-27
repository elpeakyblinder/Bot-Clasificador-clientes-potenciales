import type { APIRoute } from 'astro';
import { getDb } from '../../db';
import { env } from 'cloudflare:workers';

function getEnv(key: string): string {
  const cfEnv = env as Record<string, string> | undefined;
  if (cfEnv?.[key]) {
    return cfEnv[key];
  }
  if (import.meta.env?.[key]) {
    return import.meta.env[key] as string;
  }
  const g = globalThis as Record<string, unknown>;
  const processObj = g.process as Record<string, Record<string, string>> | undefined;
  if (processObj?.env?.[key]) {
    return processObj.env[key];
  }
  return '';
}

export const POST: APIRoute = async (context) => {
  const TELEGRAM_BOT_TOKEN = getEnv('TELEGRAM_BOT_TOKEN');
  const TELEGRAM_SECRET_TOKEN = getEnv('TELEGRAM_SECRET_TOKEN');
  const CEREBRAS_API_KEY = getEnv('CEREBRAS_API_KEY');
  const GOOGLE_SCRIPT_URL = getEnv('GOOGLE_SCRIPT_URL');
  const sql = getDb();

  const secretHeader = context.request.headers.get('X-Telegram-Bot-Api-Secret-Token');

  if (TELEGRAM_SECRET_TOKEN && secretHeader !== TELEGRAM_SECRET_TOKEN) {
    return new Response(JSON.stringify({ error: 'Acceso no autorizado.' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const body = await context.request.json() as {
      message?: {
        chat?: { id?: number };
        text?: string;
        from?: { username?: string; first_name?: string };
      };
    };
    
    if (!body || typeof body !== 'object' || !body.message) {
      return new Response(JSON.stringify({ status: 'ignored', message: 'Estructura de mensaje no valida.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const message = body.message;
    const chatId = message.chat?.id;
    const text = message.text;
    const username = message.from?.username || message.from?.first_name || 'Usuario Anonimo';

    if (!text) {
      if (chatId && TELEGRAM_BOT_TOKEN) {
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, "Hola! Por favor envíame los datos del lead en formato de texto libre para poder calificarlo. 😊");
      }
      return new Response(JSON.stringify({ status: 'ok', message: 'Non-text message ignored' }), {
        status: 200,
      });
    }

    if (text.startsWith('/start')) {
      if (chatId && TELEGRAM_BOT_TOKEN) {
        const welcomeText = `👋 ¡Hola ${username}!\n\n` +
                            `Bienvenido al Agente Inteligente de Cualificación de Leads.\n\n` +
                            `Envíame los datos de un lead en texto libre y yo me encargaré de calificarlo.\n\n` +
                            `Ejemplo:\n` +
                            `"Empresa de consultoría, 15 empleados, Madrid, quieren automatizar su proceso de ventas."\n\n` +
                            `Criterios del ICP:\n` +
                            `• Tipo: Servicios o consultoría\n` +
                            `• Tamaño: Mínimo 5 empleados\n` +
                            `• Ubicación: España o Latinoamérica\n` +
                            `• Interés: Automatización o IA`;
        await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, welcomeText);
      }
      return new Response(JSON.stringify({ status: 'ok', message: 'Start command processed' }), { status: 200 });
    }

    const lowerText = text.toLowerCase().trim();
    const saludos = ['hola', 'buenas', 'buenas tardes', 'buenos dias', 'buenos días', 'que tal', 'qué tal', 'hi', 'hello', 'test', 'saludos', 'hola bot', 'hola agente', 'hola!'];

    if (saludos.includes(lowerText) || lowerText.length < 6) {
      if (chatId && TELEGRAM_BOT_TOKEN) {
        await sendTelegramMessage(
          TELEGRAM_BOT_TOKEN,
          chatId,
          "👋 ¡Hola! Para poder calificar un lead, por favor envíame su información técnica o comercial (ej: tipo de empresa, tamaño, ubicación e interés en automatizaciones/IA). 😊"
        );
      }
      return new Response(JSON.stringify({ status: 'ok', message: 'Greeting message handled without LLM' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`Procesando lead enviado por ${username}: "${text}"`);
    
    const systemPrompt = `Eres un agente experto en cualificación de leads comerciales. Tu tarea es analizar los datos de un lead proporcionados en texto libre y decidir si encaja con nuestro Perfil de Cliente Ideal (ICP).

Criterios estrictos del ICP:
1. Tipo de empresa: Debe ser una empresa de servicios o una consultoría (por ejemplo, agencias, consultoras tecnológicas, servicios profesionales, desarrollo de software, etc.). Si es una panadería, ecommerce directo, fábrica industrial tradicional, tienda física minorista, no califica.
2. Tamaño de la empresa: Debe tener un mínimo de 5 empleados.
3. Ubicación: Debe estar en España o en cualquier país de Latinoamérica (por ejemplo, México, Colombia, Argentina, chile, Perú, etc.). Si está en EE.UU., Reino Unido u otra región fuera de la mencionada, no califica.
4. Interés: Debe mostrar interés en automatización (de procesos, ventas, marketing) o en Inteligencia Artificial (IA).

Debes responder estrictamente en formato JSON válido. No incluyas bloques de código markdown (\`\`\`json ... \`\`\`), responde únicamente con el texto JSON crudo.
La estructura del JSON debe ser exactamente:
{
  "qualified": true | false,
  "reason": "Escribe aquí tu razonamiento en español en 2 o 3 líneas, detallando qué criterios del ICP se cumplen y cuáles no."
}`;

    let qualified = false;
    let reason = "Error al analizar el lead con el modelo de inteligencia artificial.";
    let isCached = false;

    const normalizedText = text.trim();
    interface CachedLead {
      decision: string;
      reason: string;
    }

    try {
      const existingLeads = await sql`
        SELECT decision, reason 
        FROM leads 
        WHERE TRIM(raw_text) = ${normalizedText} 
        LIMIT 1
      ` as CachedLead[];

      if (existingLeads && existingLeads.length > 0) {
        qualified = existingLeads[0].decision === 'Cualificado';
        reason = existingLeads[0].reason;
        isCached = true;
        console.log(`Lead duplicado encontrado en Neon. Usando veredicto en cache: "${normalizedText}"`);
      }
    } catch (dbErr) {
      console.error("Error al consultar cache en Neon:", dbErr);
    }

    if (!isCached) {
      if (CEREBRAS_API_KEY) {
        try {
          const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${CEREBRAS_API_KEY}`
            },
            body: JSON.stringify({
              model: "gpt-oss-120b",
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: text }
              ],
              temperature: 0,
              max_tokens: 250
            })
          });

          if (response.ok) {
            const data = await response.json() as {
              choices: Array<{ message: { content: string } }>;
            };
            let rawContent = data.choices[0].message.content.trim();
            
            rawContent = rawContent.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
            
            try {
              const parsed = JSON.parse(rawContent) as { qualified?: boolean; reason?: string };
              qualified = !!parsed.qualified;
              reason = parsed.reason || "Sin justificación provista.";
            } catch (jsonErr) {
              console.error("Error parseando JSON del LLM:", jsonErr, "Contenido crudo:", rawContent);
              qualified = rawContent.toLowerCase().includes('"qualified": true') || rawContent.toLowerCase().includes('qualified":true');
              reason = "El modelo no formateó correctamente la respuesta, pero fue procesada con fallback.";
            }
          } else {
            const errorText = await response.text();
            console.error("Error en API de Cerebras:", response.status, errorText);
            reason = "La API del LLM experimentó un error temporal al procesar el mensaje.";
          }
        } catch (cerebrasErr) {
          console.error("Error en llamada de fetch a Cerebras:", cerebrasErr);
          reason = "Error interno al conectar con el motor de inteligencia artificial Cerebras.";
        }
      } else {
        console.warn("CEREBRAS_API_KEY no configurada.");
        reason = "La API Key de Cerebras no está configurada en el servidor.";
      }
    }

    const decisionText = qualified ? 'Cualificado' : 'No cualificado';

    if (chatId && TELEGRAM_BOT_TOKEN) {
      const emoji = qualified ? '🟢' : '🔴';
      const telegramResponse = `📋 RESULTADO DE LA CUALIFICACIÓN:\n` +
                               `${emoji} ${decisionText.toUpperCase()}\n\n` +
                               `MOTIVO / RAZONAMIENTO:\n` +
                               `${reason}`;
      await sendTelegramMessage(TELEGRAM_BOT_TOKEN, chatId, telegramResponse);
    }

    const isUninformative = !qualified && (
      reason.toLowerCase().includes('no se proporcionaron') ||
      reason.toLowerCase().includes('falta información') ||
      reason.toLowerCase().includes('falta de información') ||
      reason.toLowerCase().includes('no contiene') ||
      reason.toLowerCase().includes('no provee') ||
      reason.toLowerCase().includes('información insuficiente')
    );

    const dbPromise = (async () => {
      if (isUninformative) {
        console.log("Lead sin informacion relevante detectado. Omitiendo guardado en Neon Database.");
        return;
      }
      try {
        await sql`
          INSERT INTO leads (raw_text, decision, reason, username, chat_id)
          VALUES (${text}, ${decisionText}, ${reason}, ${username}, ${chatId ? BigInt(chatId) : null})
        `;
        console.log("Lead guardado exitosamente en Neon Database.");
      } catch (dbErr) {
        console.error("Error al guardar en Neon Database:", dbErr);
      }
    })();

    const sheetsPromise = (async () => {
      if (isUninformative) {
        console.log("Lead sin informacion relevante detectado. Omitiendo guardado en Google Sheets.");
        return;
      }
      if (GOOGLE_SCRIPT_URL) {
        try {
          const res = await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              date: new Date().toISOString(),
              fecha: new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date()),
              rawText: text,
              raw_text: text,
              datos: text,
              datosRecibidos: text,
              datos_recibidos: text,
              "Datos Originales": text,
              datosOriginales: text,
              datos_originales: text,
              datosoriginales: text,
              originalText: text,
              original_text: text,
              original: text,
              decision: decisionText,
              decisión: decisionText,
              reason: reason,
              motivo: reason
            })
          });
          const resultText = await res.text();
          console.log("Lead logueado en Google Sheets. Respuesta del script:", resultText);
        } catch (sheetsErr) {
          console.error("Error al loguear en Google Sheets:", sheetsErr);
        }
      } else {
        console.warn("GOOGLE_SCRIPT_URL no configurada.");
      }
    })();

    await Promise.allSettled([dbPromise, sheetsPromise]);

    return new Response(JSON.stringify({ status: 'ok', decision: decisionText }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    const error = err as Error;
    console.error("Error global en el Webhook:", error);
    return new Response(JSON.stringify({ error: error.message || 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};

async function sendTelegramMessage(token: string, chatId: number, text: string) {
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text
      })
    });
    if (!response.ok) {
      const errText = await response.text();
      console.error(`Error enviando mensaje a Telegram:`, response.status, errText);
    }
  } catch (err) {
    console.error(`Error de red al enviar mensaje a Telegram:`, err);
  }
}
