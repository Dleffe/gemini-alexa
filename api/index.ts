/**
 * Alexo — Skill Alexa conversacional contínua conectada ao Google Gemini.
 *
 * Ponto de entrada da função serverless na Vercel (assinatura Web padrão:
 * `POST(request: Request) => Response`). Fluxo:
 *
 *   1. Recebe o webhook HTTPS do Alexa Skills Kit.
 *   2. Valida assinatura + timestamp da requisição (obrigatório para skills
 *      hospedadas fora do AWS Lambda).
 *   3. Despacha o envelope para o `ask-sdk-core`.
 *   4. O handler de captura ampla extrai o texto livre (slot), envia ao
 *      Gemini 2.5 Flash e devolve a resposta mantendo a sessão aberta.
 */
import {
  DefaultApiClient,
  getIntentName,
  getRequestType,
  getSlotValue,
  SkillBuilders,
} from 'ask-sdk-core';
import type { ErrorHandler, HandlerInput, RequestHandler } from 'ask-sdk-core';
import type { RequestEnvelope, Response as AlexaResponse } from 'ask-sdk-model';
import { SkillRequestSignatureVerifier, TimestampVerifier } from 'ask-sdk-express-adapter';
import { GoogleGenAI, type Content } from '@google/genai';
import type { IncomingHttpHeaders } from 'node:http';

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

const GEMINI_MODEL = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
/** A Alexa aguarda ~8s pela resposta da skill; reservamos margem para rede/serialização. */
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 6000);
/** Quantidade máxima de turnos (pergunta+resposta) mantidos em memória de sessão. */
const MAX_HISTORY_TURNS = 6;
/** Limite de caracteres falados (respostas muito longas são cansativas por voz). */
const MAX_SPEECH_CHARS = 1500;

const SYSTEM_INSTRUCTION = [
  'Você é o Alexo, um assistente de voz em português do Brasil rodando em um dispositivo Amazon Echo.',
  'Suas respostas serão convertidas em fala, portanto:',
  '- Responda de forma natural, direta e conversacional, em no máximo 3 ou 4 frases, salvo se o usuário pedir detalhes.',
  '- NÃO use markdown, listas com marcadores, asteriscos, emojis, tabelas, URLs ou blocos de código.',
  '- Escreva números, siglas e unidades de forma que soem bem quando lidos em voz alta.',
  '- Se a pergunta for ambígua, faça uma pergunta curta de esclarecimento.',
].join('\n');

const REPROMPT = 'Pode perguntar mais alguma coisa, ou diga tchau para sair.';
const GOODBYE = 'Até mais!';

/** Termos que, quando ditos isoladamente, encerram a sessão. */
const EXIT_PATTERN =
  /^(alexo\s+)?(tchau|tchau tchau|sair|parar|pare|para|encerrar|encerra|fechar|chega|obrigad[oa],? tchau|at[eé] mais|at[eé] logo|desligar|cancelar)[.!]?$/i;

/** Remove o termo de gatilho caso o reconhecimento de fala o inclua no slot. */
const TRIGGER_PREFIX = /^(alexo|alecho|aleixo|alesso|alex[oó]|a lexo)[,\s]+/i;

// ---------------------------------------------------------------------------
// Cliente Gemini (reutilizado entre invocações "quentes" da função)
// ---------------------------------------------------------------------------

let genAI: GoogleGenAI | undefined;
function getGenAI(): GoogleGenAI {
  if (!genAI) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY não configurada.');
    genAI = new GoogleGenAI({ apiKey });
  }
  return genAI;
}

type HistoryTurn = { role: 'user' | 'model'; text: string };

async function askGemini(question: string, history: HistoryTurn[]): Promise<string> {
  const contents: Content[] = [
    ...history.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: 'user', parts: [{ text: question }] },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const result = await getGenAI().models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        maxOutputTokens: 400,
        temperature: 0.7,
        // Desliga o "thinking" do 2.5 Flash para minimizar latência em voz.
        thinkingConfig: { thinkingBudget: 0 },
        abortSignal: controller.signal,
      },
    });
    return result.text?.trim() ?? '';
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Utilidades de fala
// ---------------------------------------------------------------------------

/** Converte texto do LLM em conteúdo seguro para SSML. */
function toSpeech(text: string): string {
  let clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_#`~>|]/g, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length > MAX_SPEECH_CHARS) {
    const cut = clean.slice(0, MAX_SPEECH_CHARS);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    clean = lastStop > 200 ? cut.slice(0, lastStop + 1) : `${cut}...`;
  }
  return clean
    .replace(/&/g, ' e ')
    .replace(/</g, ' menor que ')
    .replace(/>/g, ' maior que ')
    .replace(/"/g, '')
    .replace(/'/g, '');
}

/** Extrai o texto livre de qualquer um dos slots de captura ampla. */
function extractUtterance(handlerInput: HandlerInput): string {
  const envelope = handlerInput.requestEnvelope;
  const raw =
    getSlotValue(envelope, 'query') ?? // AMAZON.SearchQuery (CustomTriggerIntent)
    getSlotValue(envelope, 'texto') ?? // CatchAllType (CatchAllIntent)
    '';
  return raw.trim().replace(TRIGGER_PREFIX, '').trim();
}

/** Envia uma resposta progressiva ("Hum, deixa eu pensar...") sem bloquear o fluxo. */
function sendProgressiveResponse(handlerInput: HandlerInput): void {
  try {
    const requestId = handlerInput.requestEnvelope.request.requestId;
    const client = handlerInput.serviceClientFactory?.getDirectiveServiceClient();
    if (!client || !requestId) return;
    void client
      .enqueue({
        header: { requestId },
        directive: { type: 'VoicePlayer.Speak', speech: '<speak>Hum.</speak>' },
      })
      .catch(() => undefined);
  } catch {
    /* resposta progressiva é opcional */
  }
}

function endSession(handlerInput: HandlerInput): AlexaResponse {
  return handlerInput.responseBuilder.speak(GOODBYE).withShouldEndSession(true).getResponse();
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const LaunchRequestHandler: RequestHandler = {
  canHandle: (h) => getRequestType(h.requestEnvelope) === 'LaunchRequest',
  handle: (h) =>
    h.responseBuilder
      .speak('Oi, aqui é o Alexo. O que você quer saber?')
      .reprompt('Pode perguntar o que quiser.')
      .withShouldEndSession(false)
      .getResponse(),
};

/**
 * Handler de captura ampla: atende tanto a CustomTriggerIntent ("alexo {query}")
 * quanto a CatchAllIntent ("{texto}") usada para continuar a conversa sem prefixo.
 */
const GeminiConversationHandler: RequestHandler = {
  canHandle: (h) =>
    getRequestType(h.requestEnvelope) === 'IntentRequest' &&
    ['CustomTriggerIntent', 'CatchAllIntent'].includes(getIntentName(h.requestEnvelope)),
  async handle(h) {
    const question = extractUtterance(h);

    if (!question) {
      return h.responseBuilder
        .speak('Não entendi direito. Pode repetir?')
        .reprompt(REPROMPT)
        .withShouldEndSession(false)
        .getResponse();
    }

    if (EXIT_PATTERN.test(question)) return endSession(h);

    const attributes = h.attributesManager.getSessionAttributes();
    const history: HistoryTurn[] = Array.isArray(attributes.history) ? attributes.history : [];

    sendProgressiveResponse(h);

    let answer: string;
    try {
      answer = await askGemini(question, history);
    } catch (err) {
      const aborted = err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message));
      console.error('[gemini] erro:', err);
      return h.responseBuilder
        .speak(
          aborted
            ? 'Essa demorou demais para responder. Tente perguntar de um jeito mais curto.'
            : 'Tive um problema para falar com o Gemini agora. Tente de novo em instantes.',
        )
        .reprompt(REPROMPT)
        .withShouldEndSession(false)
        .getResponse();
    }

    if (!answer) answer = 'Não consegui pensar em uma resposta para isso. Pode reformular?';

    // Memória curta de conversa nos atributos de sessão (limite ~24 KB por resposta).
    attributes.history = [
      ...history,
      { role: 'user', text: question.slice(0, 500) },
      { role: 'model', text: answer.slice(0, 1200) },
    ].slice(-MAX_HISTORY_TURNS * 2);
    h.attributesManager.setSessionAttributes(attributes);

    return h.responseBuilder
      .speak(toSpeech(answer))
      .reprompt(REPROMPT)
      .withShouldEndSession(false) // Sessão contínua: microfone permanece aberto.
      .getResponse();
  },
};

const HelpIntentHandler: RequestHandler = {
  canHandle: (h) =>
    getRequestType(h.requestEnvelope) === 'IntentRequest' &&
    getIntentName(h.requestEnvelope) === 'AMAZON.HelpIntent',
  handle: (h) =>
    h.responseBuilder
      .speak('Diga Alexo seguido da sua pergunta, por exemplo: Alexo, qual a distância até a Lua? Para sair, diga tchau.')
      .reprompt(REPROMPT)
      .withShouldEndSession(false)
      .getResponse(),
};

const StopIntentHandler: RequestHandler = {
  canHandle: (h) =>
    getRequestType(h.requestEnvelope) === 'IntentRequest' &&
    ['AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.NavigateHomeIntent', 'ExitIntent'].includes(
      getIntentName(h.requestEnvelope),
    ),
  handle: endSession,
};

const FallbackIntentHandler: RequestHandler = {
  canHandle: (h) =>
    getRequestType(h.requestEnvelope) === 'IntentRequest' &&
    getIntentName(h.requestEnvelope) === 'AMAZON.FallbackIntent',
  handle: (h) =>
    h.responseBuilder
      .speak('Não peguei isso. Tente começar com: Alexo, e depois a sua pergunta.')
      .reprompt(REPROMPT)
      .withShouldEndSession(false)
      .getResponse(),
};

const SessionEndedRequestHandler: RequestHandler = {
  canHandle: (h) => getRequestType(h.requestEnvelope) === 'SessionEndedRequest',
  handle: (h) => {
    const req = h.requestEnvelope.request as { reason?: string; error?: unknown };
    console.log('[session] encerrada:', req.reason, req.error ?? '');
    return h.responseBuilder.getResponse();
  },
};

const GlobalErrorHandler: ErrorHandler = {
  canHandle: () => true,
  handle: (h, error) => {
    console.error('[skill] erro não tratado:', error);
    return h.responseBuilder
      .speak('Desculpe, algo deu errado. Pode tentar de novo?')
      .reprompt(REPROMPT)
      .withShouldEndSession(false)
      .getResponse();
  },
};

const skillBuilder = SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    GeminiConversationHandler,
    HelpIntentHandler,
    StopIntentHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler,
  )
  .addErrorHandlers(GlobalErrorHandler)
  .withApiClient(new DefaultApiClient());

if (process.env.ALEXA_SKILL_ID) skillBuilder.withSkillId(process.env.ALEXA_SKILL_ID);

const skill = skillBuilder.create();

// ---------------------------------------------------------------------------
// Adaptador HTTP (Vercel Functions — assinatura Web padrão)
// ---------------------------------------------------------------------------

function headersToNode(headers: Headers): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8' },
  });
}

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();

  // Verificação exigida pela Amazon para endpoints HTTPS fora do Lambda.
  if (process.env.SKIP_ALEXA_VERIFICATION !== 'true') {
    try {
      await new SkillRequestSignatureVerifier().verify(rawBody, headersToNode(request.headers));
      await new TimestampVerifier().verify(rawBody);
    } catch (err) {
      console.warn('[verify] requisição rejeitada:', err instanceof Error ? err.message : err);
      return json({ error: 'Invalid Alexa request' }, 400);
    }
  }

  let envelope: RequestEnvelope;
  try {
    envelope = JSON.parse(rawBody) as RequestEnvelope;
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  try {
    const response = await skill.invoke(envelope);
    return json(response);
  } catch (err) {
    // Ex.: skill ID divergente.
    console.error('[skill] falha ao processar envelope:', err);
    return json({ error: 'Skill invocation failed' }, 500);
  }
}

/** Health check simples para validar o deploy no navegador. */
export function GET(): Response {
  return json({ status: 'ok', service: 'alexo-gemini', model: GEMINI_MODEL });
}
