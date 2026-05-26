import type { APIRoute } from 'astro';
import { getDb } from '../../db';
import type { Lead } from '../../types';
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
  const CEREBRAS_API_KEY = getEnv('CEREBRAS_API_KEY');
  const GOOGLE_SCRIPT_URL = getEnv('GOOGLE_SCRIPT_URL');
  const sql = getDb();

  try {
    const body = await context.request.json();
    const { text } = body;

    if (!text || typeof text !== 'string' || text.trim() === '') {
      return new Response(JSON.stringify({ error: 'El texto del lead es requerido.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log(`Procesando lead de simulación desde el Dashboard: "${text}"`);

    const systemPrompt = `Eres un agente experto en cualificación de leads comerciales. Tu tarea es analizar los datos de un lead proporcionados en texto libre y decidir si encaja con nuestro Perfil de Cliente Ideal (ICP).

Criterios estrictos del ICP:
1. Tipo de empresa: Debe ser una empresa de servicios o una consultoría (por ejemplo, agencias, consultoras tecnológicas, servicios profesionales, desarrollo de software, etc.). Si es una panadería, ecommerce directo, fábrica industrial tradicional, tienda física minorista, no califica.
2. Tamaño de la empresa: Debe tener un mínimo de 5 empleados.
3. Ubicación: Debe estar en España o en cualquier país de Latinoamérica (por ejemplo, México, Colombia, Argentina, Chile, Perú, etc.). Si está en EE.UU., Reino Unido u otra región fuera de la mencionada, no califica.
4. Interés: Debe mostrar interés en automatización (de procesos, ventas, marketing) o en Inteligencia Artificial (IA).

Debes responder estrictamente en formato JSON válido. No incluyas bloques de código markdown (\`\`\`json ... \`\`\`), responde únicamente con el texto JSON crudo.
La estructura del JSON debe ser exactamente:
{
  "qualified": true | false,
  "reason": "Escribe aquí tu razonamiento en español en 2 o 3 líneas, detallando qué criterios del ICP se cumplen y cuáles no."
}`;

    let qualified = false;
    let reason = "Error al calificar el lead.";

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
            temperature: 0
          })
        });

        if (response.ok) {
          const data = await response.json();
          let rawContent = data.choices[0].message.content.trim();
          
          rawContent = rawContent.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
          
          try {
            const parsed = JSON.parse(rawContent);
            qualified = !!parsed.qualified;
            reason = parsed.reason || "Sin justificación provista.";
          } catch (jsonErr) {
            console.error("Error parseando JSON en simulador:", jsonErr);
            qualified = rawContent.toLowerCase().includes('"qualified": true') || rawContent.toLowerCase().includes('qualified":true');
            reason = "La IA no devolvió un JSON perfecto, pero se parseó con fallback.";
          }
        } else {
          const errorText = await response.text();
          console.error("Error de Cerebras en simulador:", response.status, errorText);
          reason = "Error de respuesta del LLM.";
        }
      } catch (err) {
        console.error("Error de red al conectar con Cerebras en simulador:", err);
        reason = "Error al conectar con la API de Cerebras.";
      }
    } else {
      reason = "API Key de Cerebras no configurada.";
    }

    const decisionText = qualified ? 'Cualificado' : 'No cualificado';
    const username = 'Simulador Dashboard';

    let savedLeadId = null;
    try {
      const result = await sql`
        INSERT INTO leads (raw_text, decision, reason, username, chat_id)
        VALUES (${text}, ${decisionText}, ${reason}, ${username}, NULL)
        RETURNING id, created_at
      ` as Lead[];
      if (result && result.length > 0) {
        savedLeadId = result[0].id;
      }
      console.log("Lead de simulación guardado en Neon.");
    } catch (dbErr) {
      console.error("Error al guardar lead de simulación en Neon:", dbErr);
    }

    const sheetsPromise = (async () => {
      if (GOOGLE_SCRIPT_URL) {
        try {
          await fetch(GOOGLE_SCRIPT_URL, {
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
          console.log("Lead de simulación logueado en Google Sheets.");
        } catch (sheetsErr) {
          console.error("Error al loguear simulación en Google Sheets:", sheetsErr);
        }
      }
    })();

    Promise.allSettled([sheetsPromise]);

    return new Response(JSON.stringify({
      success: true,
      lead: {
        id: savedLeadId,
        created_at: new Date().toISOString(),
        raw_text: text,
        decision: decisionText,
        reason: reason,
        username: username
      }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    const error = err as Error;
    console.error("Error global en simulador:", error);
    return new Response(JSON.stringify({ error: error.message || 'Internal Server Error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
