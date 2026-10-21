/**
 * Teste local do handler sem Alexa real.
 *
 * Uso:
 *   GEMINI_API_KEY=xxx SKIP_ALEXA_VERIFICATION=true npm run test:local -- "alexo qual a capital da austrália"
 */
process.env.SKIP_ALEXA_VERIFICATION = 'true';

const { POST } = await import('../api/index.ts');

const text = process.argv.slice(2).join(' ') || 'qual a capital da austrália';
const exitTest = /^(tchau|sair|parar)$/i.test(text);

const envelope = {
  version: '1.0',
  session: {
    new: false,
    sessionId: 'amzn1.echo-api.session.local-test',
    application: { applicationId: process.env.ALEXA_SKILL_ID ?? 'amzn1.ask.skill.local' },
    attributes: {},
    user: { userId: 'amzn1.ask.account.local' },
  },
  context: {
    System: {
      application: { applicationId: process.env.ALEXA_SKILL_ID ?? 'amzn1.ask.skill.local' },
      user: { userId: 'amzn1.ask.account.local' },
      device: { deviceId: 'local', supportedInterfaces: {} },
      apiEndpoint: 'https://api.amazonalexa.com',
    },
  },
  request: {
    type: 'IntentRequest',
    requestId: 'amzn1.echo-api.request.local-test',
    timestamp: new Date().toISOString(),
    locale: 'pt-BR',
    intent: exitTest
      ? { name: 'ExitIntent', confirmationStatus: 'NONE', slots: {} }
      : {
          name: 'CatchAllIntent',
          confirmationStatus: 'NONE',
          slots: { texto: { name: 'texto', value: text, confirmationStatus: 'NONE' } },
        },
  },
};

const res = await POST(
  new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(envelope) }),
);
console.log(res.status, JSON.stringify(await res.json(), null, 2));
