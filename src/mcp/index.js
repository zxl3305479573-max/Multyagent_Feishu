import { McpService, resultText, toolName } from "./service.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkMcpToolCall } from "../agent/policy-gate.js";

let service = null;

export function getMcpService() {
  if (!service) service = new McpService();
  return service;
}

export function setMcpService(value) { service = value; }

export function mcpToolsForRole(role, mcpService = getMcpService()) {
  const definitions = mcpService.toolsForRole(role);
  return definitions.map(({ server, definition, name }) => defineTool({
    name,
    label: `MCP · ${server.name}`,
    description: `${definition.description || definition.name}（来源：MCP ${server.name}）`,
    parameters: Type.Unsafe(definition.inputSchema || { type: "object", properties: {}, additionalProperties: true }),
    execute: async (_toolCallId, params) => {
      const policy = checkMcpToolCall(name, params, { allowedTools: new Set(definitions.map((item) => item.name)) });
      if (policy) return { content: [{ type: "text", text: policy.reason }], details: { blocked: true } };
      const result = await mcpService.call(server.id, definition.name, params);
      return { content: [{ type: "text", text: resultText(result) }], details: { server: server.id, tool: definition.name } };
    },
  }));
}

export { toolName };
