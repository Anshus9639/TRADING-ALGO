jest.mock('@google/generative-ai', () => {
  const getGenerativeModel = jest.fn(config => ({
    config,
    generateContent: jest.fn(async () => ({
      response: {
        text: () => JSON.stringify({
          side: 'BUY',
          symbol: 'BTCUSDT',
          orderType: 'MARKET',
          quantity: 1,
          limitPrice: null,
          notional: null,
          allAvailable: false,
          clarification: null
        })
      }
    }))
  }));

  return {
    SchemaType: { OBJECT: 'OBJECT', STRING: 'STRING', NUMBER: 'NUMBER', BOOLEAN: 'BOOLEAN' },
    GoogleGenerativeAI: jest.fn(() => ({ getGenerativeModel })),
    __getGenerativeModel: getGenerativeModel
  };
});

const { __getGenerativeModel: getGenerativeModel } = require('@google/generative-ai');
const { createGeminiIntentExtractor } = require('../services/ai/gemini');
const { symbolUniverse } = require('../services/symbolUniverse');
const { PINNED_SYMBOLS } = require('../lib/symbols');

function lastSchema() {
  return getGenerativeModel.mock.calls.at(-1)[0].generationConfig.responseSchema;
}

describe('gemini intent extractor symbol universe', () => {
  beforeEach(() => {
    getGenerativeModel.mockClear();
    symbolUniverse.reset();
  });

  afterEach(() => {
    symbolUniverse.reset();
  });

  test('builds the response schema from the active catalogue, not a fixed list', async () => {
    const extractor = createGeminiIntentExtractor({ apiKey: 'test-key' });

    await extractor.extract({ prompt: 'buy 1 btc', context: {} });
    expect(lastSchema().properties.symbol.enum).toEqual([...PINNED_SYMBOLS]);

    symbolUniverse.setActive([...PINNED_SYMBOLS, 'DOGEUSDT']);
    await extractor.extract({ prompt: 'buy 100 doge', context: {} });

    expect(lastSchema().properties.symbol.enum).toContain('DOGEUSDT');
    expect(getGenerativeModel).toHaveBeenCalledTimes(2);
  });

  test('reuses the model while the active set is unchanged', async () => {
    const extractor = createGeminiIntentExtractor({ apiKey: 'test-key' });

    await extractor.extract({ prompt: 'buy 1 btc', context: {} });
    await extractor.extract({ prompt: 'sell 1 btc', context: {} });

    expect(getGenerativeModel).toHaveBeenCalledTimes(1);
  });

  test('accepts an explicit symbol source for callers that do not use the singleton', async () => {
    const extractor = createGeminiIntentExtractor({
      apiKey: 'test-key',
      symbols: () => ['SOLUSDT', 'ETHUSDT']
    });

    await extractor.extract({ prompt: 'buy 1 sol', context: {} });
    expect(lastSchema().properties.symbol.enum).toEqual(['SOLUSDT', 'ETHUSDT']);
  });
});
