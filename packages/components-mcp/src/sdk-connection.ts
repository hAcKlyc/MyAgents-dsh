import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  McpConnection,
  McpConnectionFactory,
  McpConnectionFactoryInput,
  McpListedTool,
} from "./compiler.js";
import { isProxy } from "node:util/types";

export interface SdkMcpTransportFactory {
  readonly createTransport: (input: McpConnectionFactoryInput) => Promise<Transport>;
}

const options = (signal: AbortSignal): RequestOptions => Object.freeze({ signal });

export const createSdkMcpConnectionFactory = (
  transportFactory: SdkMcpTransportFactory,
): McpConnectionFactory => {
  if (isProxy(transportFactory) || typeof transportFactory.createTransport !== "function"
    || isProxy(transportFactory.createTransport)) {
    throw new TypeError("SDK MCP connection requires a trusted transport factory");
  }
  const createTransport = transportFactory.createTransport;
  return Object.freeze({
    connect: async (input: McpConnectionFactoryInput): Promise<McpConnection> => {
      input.signal.throwIfAborted();
      const transport = await Reflect.apply(createTransport, transportFactory, [input]) as Transport;
      input.signal.throwIfAborted();
      const client = new Client({ name: "myagents-dsh-runtime", version: "1.0.0" }, { capabilities: {} });
      try {
        await client.connect(transport, options(input.signal));
        input.signal.throwIfAborted();
      } catch (error) {
        try {
          await transport.close();
        } catch (closeError) {
          throw new AggregateError(
            [error, closeError],
            "MCP SDK connection and transport cleanup failed",
            { cause: closeError },
          );
        }
        throw error;
      }
      const connection: McpConnection = Object.freeze({
        callTool: (name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal) => client.callTool(
          Object.freeze({ arguments: args, name }),
          undefined,
          options(signal),
        ),
        close: () => client.close(),
        listTools: async (signal: AbortSignal): Promise<readonly McpListedTool[]> =>
          (await client.listTools(undefined, options(signal))).tools.map((tool) => Object.freeze({
            ...(tool.description === undefined ? {} : { description: tool.description }),
            inputSchema: tool.inputSchema,
            name: tool.name,
          })) as readonly McpListedTool[],
      });
      return connection;
    },
  });
};
