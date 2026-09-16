import { GeminiProvider, OpenAICompatibleProvider, ProviderRegistry } from '@relay/providers';
import { createApp } from './app.js';
import { loadConfig, type RelayConfig } from './config/index.js';

export function createRegistry(config: RelayConfig): ProviderRegistry {
  const registry = new ProviderRegistry();

  // Wire up Gemini provider if API key is configured
  if (config.env.GEMINI_API_KEY) {
    const gemini = new GeminiProvider({
      apiKey: config.env.GEMINI_API_KEY,
      baseUrl: config.env.GEMINI_BASE_URL,
    });
    registry.registerProvider(gemini);
  }

  // Register all configured OpenAI-compatible backends uniformly
  for (const backend of config.openAiCompatibleBackends) {
    const providerOptions: {
      id: string;
      name: string;
      baseUrl: string;
      apiKey?: string;
    } = {
      id: backend.id,
      name: backend.name,
      baseUrl: backend.baseUrl,
    };
    if (backend.apiKey) {
      providerOptions.apiKey = backend.apiKey;
    }
    const provider = new OpenAICompatibleProvider(providerOptions);
    registry.registerProvider(provider);
  }

  // Register default configured models
  for (const model of config.defaultModels) {
    if (registry.getProvider(model.provider)) {
      registry.registerModel(model);
    }
  }

  return registry;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const registry = createRegistry(config);

  const app = await createApp({ config, registry });

  // Graceful shutdown handling
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.once(signal, async () => {
      app.log.info({ signal }, 'Shutting down Relay gateway...');
      try {
        await app.close();
        app.log.info('Relay gateway shutdown complete.');
        process.exit(0);
      } catch (err) {
        app.log.error(err, 'Error during graceful shutdown');
        process.exit(1);
      }
    });
  }

  try {
    await app.listen({
      port: config.env.PORT,
      host: config.env.HOST,
    });
    app.log.info(
      {
        port: config.env.PORT,
        host: config.env.HOST,
        models: registry.listModels().map((m) => m.id),
      },
      'Relay gateway is running and ready to accept requests.',
    );
  } catch (err) {
    app.log.fatal(err, 'Failed to start Relay gateway');
    process.exit(1);
  }
}

// Run server only if executed directly
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  main().catch((err) => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
