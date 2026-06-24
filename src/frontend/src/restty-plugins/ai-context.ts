import { RESTTY_PLUGIN_API_VERSION, type ResttyPlugin, type ResttyPluginContext } from "restty";

export const AI_CONTEXT_PLUGIN_ID = "lazycat/ai-context";

export type AIContextPluginOptions = {
  onOutput: (text: string, source: string) => void;
};

export function createAIContextPlugin(options: AIContextPluginOptions): ResttyPlugin {
  return {
    id: AI_CONTEXT_PLUGIN_ID,
    version: "1.0.0",
    apiVersion: RESTTY_PLUGIN_API_VERSION,
    requires: {
      pluginApi: {
        min: RESTTY_PLUGIN_API_VERSION,
        max: RESTTY_PLUGIN_API_VERSION,
      },
    },
    activate(ctx: ResttyPluginContext) {
      const output = ctx.addOutputInterceptor(({ text, source }) => {
        if (text) options.onOutput(text, source);
        return undefined;
      });

      return () => {
        output.dispose();
      };
    },
  };
}
