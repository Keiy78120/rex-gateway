/**
 * Rex Brain — OpenClaw extension entry point
 *
 * Registers all Rex capabilities into the OpenClaw gateway:
 *  - Hooks: identity injection, model routing, message logging, tool auditing
 *  - Service: background daemon (health, Milo monitor, fleet, memory ingest)
 *  - Commands: /status, /fleet, /train, /join
 *  - Tools: rex_memory_search, rex_fleet_status, rex_deploy_agent, rex_milo_monitor
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { definePluginEntry } from "./api.js";
import { createRexDaemonService, getRecentLogs } from "./daemon.js";
import { REX_SYSTEM_PROMPT, detectMessageIntent } from "./identity.js";
import {
  routeRequest,
  getOpusUsageToday,
  setOpusDailyLimit,
  setOllamaUrl,
  classifyDataSensitivity,
  stripPII,
} from "./routing.js";

// ── Rex CLI binary resolution ────────────────────────────────────────────────

function findRexBin(): string {
  const candidates = [
    join(homedir(), ".nvm", "versions", "node", "v22.20.0", "bin", "rex"),
    join(homedir(), ".local", "bin", "rex"),
    "/usr/local/bin/rex",
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "rex";
}

const REX_BIN = findRexBin();

function runRexAsync(args: string[], timeoutMs = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(REX_BIN, args, { encoding: "utf-8", timeout: timeoutMs }, (err, stdout) => {
      if (err || !stdout?.trim()) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// ── Plugin entry ─────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "rex-brain",
  name: "Rex Brain",
  description: "Rex identity, 6-tier routing, daemon cycles, and orchestration tools",
  register(api) {
    // Apply plugin config overrides
    const pluginCfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    if (typeof pluginCfg.opusDailyLimit === "number") {
      setOpusDailyLimit(pluginCfg.opusDailyLimit);
    }
    if (typeof pluginCfg.ollamaUrl === "string") {
      setOllamaUrl(pluginCfg.ollamaUrl);
    }

    // ── Hook: before_prompt_build — inject Rex identity ──────────────────

    api.on(
      "before_prompt_build",
      async () => ({
        prependSystemContext: REX_SYSTEM_PROMPT,
      }),
      { priority: 10 },
    );

    // ── Hook: before_model_resolve — 6-tier routing ─────────────────────

    api.on(
      "before_model_resolve",
      async (event) => {
        const decision = await routeRequest(event.prompt);
        if (decision.tier === "script") return;
        return {
          modelOverride: decision.model,
          providerOverride: decision.provider,
        };
      },
      { priority: 10 },
    );

    // ── Hook: message_received — central logging ────────────────────────

    api.on("message_received", (event, ctx) => {
      const intent = detectMessageIntent(event.content ?? "");
      const sensitivity = classifyDataSensitivity(event.content ?? "");
      const safeContent =
        sensitivity === "sensitive"
          ? stripPII(event.content ?? "")
          : (event.content ?? "").slice(0, 100);

      api.logger.info(
        `[rex-brain] message_received from=${event.from} channel=${ctx.channelId ?? "?"} intent=${intent} sensitivity=${sensitivity} preview="${safeContent.slice(0, 60)}"`,
      );
    });

    // ── Hook: after_tool_call — audit logging ───────────────────────────

    api.on("after_tool_call", (event, ctx) => {
      const durationStr = typeof event.durationMs === "number" ? `${event.durationMs}ms` : "?";
      const status = event.error ? `error: ${event.error.slice(0, 80)}` : "ok";

      api.logger.info(
        `[rex-brain] tool_call tool=${event.toolName} agent=${ctx.agentId ?? "?"} duration=${durationStr} status=${status}`,
      );
    });

    // ── Service: rex-daemon ─────────────────────────────────────────────

    api.registerService(createRexDaemonService());

    // ── Command: /status ────────────────────────────────────────────────

    api.registerCommand({
      name: "status",
      description: "Show Rex system status (health, memory, fleet, Opus budget)",
      acceptsArgs: false,
      requireAuth: true,
      async handler(_ctx) {
        const opusUsage = getOpusUsageToday();
        const parts: string[] = [];

        parts.push("*Rex Status*");
        parts.push(`Opus budget: ${opusUsage.used}/${opusUsage.limit} today`);

        // Rex doctor
        const doctorOutput = await runRexAsync(["doctor", "--json"]);
        if (doctorOutput) {
          try {
            const parsed = JSON.parse(doctorOutput);
            const overall = parsed.overall ?? parsed.status ?? "unknown";
            parts.push(`Health: ${overall}`);
          } catch {
            parts.push(`Health: ${doctorOutput.slice(0, 200)}`);
          }
        } else {
          parts.push("Health: rex CLI unavailable");
        }

        // Recent daemon logs
        const logs = getRecentLogs(5);
        if (logs.length > 0) {
          parts.push("\n*Recent daemon events:*");
          for (const entry of logs) {
            parts.push(`[${entry.level}] ${entry.source}: ${entry.message.slice(0, 100)}`);
          }
        }

        return { text: parts.join("\n") };
      },
    });

    // ── Command: /fleet ─────────────────────────────────────────────────

    api.registerCommand({
      name: "fleet",
      description: "Show fleet device status (Tailscale nodes, containers)",
      acceptsArgs: false,
      requireAuth: true,
      async handler(_ctx) {
        const parts: string[] = ["*Rex Fleet Status*"];

        // Hub status via rex CLI
        const hubOutput = await runRexAsync(["hub", "status", "--json"]);
        if (hubOutput) {
          try {
            const parsed = JSON.parse(hubOutput);
            parts.push(JSON.stringify(parsed, null, 2).slice(0, 1500));
          } catch {
            parts.push(hubOutput.slice(0, 500));
          }
        } else {
          parts.push("Fleet data unavailable (rex CLI not found)");
        }

        // Container status
        try {
          const containerResult = await new Promise<string>((resolve) => {
            execFile(
              "docker",
              ["ps", "--format", "{{.Names}}: {{.Status}}"],
              { encoding: "utf-8", timeout: 5000 },
              (err, stdout) => resolve(err ? "Docker unavailable" : stdout.trim()),
            );
          });
          if (containerResult) {
            parts.push("\n*Containers:*");
            parts.push(containerResult.slice(0, 500));
          }
        } catch {
          parts.push("Docker unavailable");
        }

        return { text: parts.join("\n") };
      },
    });

    // ── Command: /train ─────────────────────────────────────────────────

    api.registerCommand({
      name: "train",
      description: "Trigger Rex training pipeline (ingest + categorize)",
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const subcommand = ctx.args?.trim() ?? "status";

        if (subcommand === "run" || subcommand === "start") {
          const ingestResult = await runRexAsync(["ingest"], 60_000);
          const categorizeResult = await runRexAsync(["categorize", "--batch=100"], 60_000);

          return {
            text: [
              "*Rex Training Pipeline*",
              `Ingest: ${ingestResult ? "done" : "failed"}`,
              `Categorize: ${categorizeResult ? "done" : "failed"}`,
            ].join("\n"),
          };
        }

        // Default: show training status
        const statusOutput = await runRexAsync(["categorize", "--status"]);
        return {
          text: statusOutput
            ? `*Training Status*\n${statusOutput.slice(0, 1000)}`
            : "Training status unavailable",
        };
      },
    });

    // ── Command: /join ──────────────────────────────────────────────────

    api.registerCommand({
      name: "join",
      description: "Join Rex to a fleet node or pair a new device",
      acceptsArgs: true,
      requireAuth: true,
      async handler(ctx) {
        const target = ctx.args?.trim();
        if (!target) {
          return { text: "Usage: /join <device-ip-or-name>\nExample: /join 100.91.130.59" };
        }

        // Ping the target
        const pingResult = await new Promise<boolean>((resolve) => {
          execFile("ping", ["-c", "1", "-W", "3", target], { timeout: 5000 }, (err) =>
            resolve(!err),
          );
        });

        if (!pingResult) {
          return { text: `Device ${target} is unreachable. Check Tailscale connection.` };
        }

        return {
          text: `Device ${target} is reachable. Fleet pairing ready.\nUse \`rex hub pair ${target}\` to complete the pairing.`,
        };
      },
    });

    // ── Tool: rex_memory_search ─────────────────────────────────────────

    api.registerTool(
      (_ctx) => ({
        name: "rex_memory_search",
        label: "Rex Memory Search",
        description:
          "Search Rex's semantic memory (past sessions, notes, projects). Returns relevant memory chunks ranked by similarity.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: "Max results (default 5)" })),
        }),
        async execute(_toolCallId, params) {
          const query =
            typeof params.query === "string" ? params.query : String(params.query ?? "");
          const limit = typeof params.limit === "number" ? Math.min(params.limit, 20) : 5;

          const result = await runRexAsync(["search", query, `--limit=${limit}`, "--json"], 10_000);

          if (!result) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ results: [], message: "Memory search unavailable" }),
                },
              ],
              details: {},
            };
          }

          try {
            const parsed = JSON.parse(result);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(parsed) }],
              details: {},
            };
          } catch {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ results: [], raw: result.slice(0, 500) }),
                },
              ],
              details: {},
            };
          }
        },
      }),
      { name: "rex_memory_search" },
    );

    // ── Tool: rex_fleet_status ──────────────────────────────────────────

    api.registerTool(
      (_ctx) => ({
        name: "rex_fleet_status",
        label: "Rex Fleet Status",
        description:
          "Get the status of Rex's fleet (Mac, PC, VPS nodes). Shows Tailscale connectivity, Docker containers, and device health.",
        parameters: Type.Object({
          node: Type.Optional(Type.String({ description: "Specific node IP to check (optional)" })),
        }),
        async execute(_toolCallId, params) {
          const nodeIp = typeof params.node === "string" ? params.node.trim() : undefined;

          if (nodeIp) {
            const pingOk = await new Promise<boolean>((resolve) => {
              execFile("ping", ["-c", "1", "-W", "3", nodeIp], { timeout: 5000 }, (err) =>
                resolve(!err),
              );
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    node: nodeIp,
                    reachable: pingOk,
                    checkedAt: new Date().toISOString(),
                  }),
                },
              ],
              details: {},
            };
          }

          const hubOutput = await runRexAsync(["hub", "status", "--json"]);
          const daemonLogs = getRecentLogs(10).filter((l) => l.source === "fleet");

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  hub: hubOutput ? JSON.parse(hubOutput) : null,
                  recentFleetEvents: daemonLogs,
                  checkedAt: new Date().toISOString(),
                }),
              },
            ],
            details: {},
          };
        },
      }),
      { name: "rex_fleet_status" },
    );

    // ── Tool: rex_deploy_agent ──────────────────────────────────────────

    api.registerTool(
      (_ctx) => ({
        name: "rex_deploy_agent",
        label: "Rex Deploy Agent",
        description:
          "Deploy or restart an agent on a fleet node. Supports Docker containers and SSH-based deployment.",
        parameters: Type.Object({
          agent: Type.String({
            description: "Agent name (e.g., milo, garry, ada)",
          }),
          action: Type.String({
            description: "Action to perform: start, stop, restart, status",
          }),
          node: Type.Optional(
            Type.String({
              description: "Target node IP (defaults to VPS 109.176.197.27)",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const agent = typeof params.agent === "string" ? params.agent.trim() : "";
          const action = typeof params.action === "string" ? params.action.trim() : "";
          const node = typeof params.node === "string" ? params.node.trim() : "109.176.197.27";

          const text = (msg: string) => ({
            content: [{ type: "text" as const, text: msg }],
            details: {},
          });

          if (!agent || !action) {
            return text(JSON.stringify({ error: "agent and action are required" }));
          }

          const validActions = ["start", "stop", "restart", "status"];
          if (!validActions.includes(action)) {
            return text(
              JSON.stringify({
                error: `Invalid action '${action}'. Valid: ${validActions.join(", ")}`,
              }),
            );
          }

          const containerMap: Record<string, string> = {
            milo: "milo-openclaw",
            garry: "openclaw-bot",
          };
          const containerName = containerMap[agent.toLowerCase()] ?? `${agent}-openclaw`;

          if (action === "status") {
            const { stdout, exitCode } = await new Promise<{
              stdout: string;
              exitCode: number;
            }>((resolve) => {
              execFile(
                "ssh",
                [`root@${node}`, `docker inspect --format '{{.State.Status}}' ${containerName}`],
                { encoding: "utf-8", timeout: 10_000 },
                (err, stdout) =>
                  resolve({
                    stdout: stdout?.trim() ?? "",
                    exitCode: err ? 1 : 0,
                  }),
              );
            });

            return text(
              JSON.stringify({
                agent,
                container: containerName,
                node,
                status: exitCode === 0 ? stdout : "unreachable",
              }),
            );
          }

          const dockerCmd =
            action === "restart"
              ? `docker restart ${containerName}`
              : `docker ${action} ${containerName}`;

          const { stdout, exitCode, stderr } = await new Promise<{
            stdout: string;
            stderr: string;
            exitCode: number;
          }>((resolve) => {
            execFile(
              "ssh",
              [`root@${node}`, dockerCmd],
              { encoding: "utf-8", timeout: 15_000 },
              (err, stdout, stderr) =>
                resolve({
                  stdout: stdout?.trim() ?? "",
                  stderr: stderr?.trim() ?? "",
                  exitCode: err ? 1 : 0,
                }),
            );
          });

          return text(
            JSON.stringify({
              agent,
              container: containerName,
              node,
              action,
              success: exitCode === 0,
              output: stdout || stderr,
            }),
          );
        },
      }),
      { name: "rex_deploy_agent" },
    );

    // ── Tool: rex_milo_monitor ──────────────────────────────────────────

    api.registerTool(
      (_ctx) => ({
        name: "rex_milo_monitor",
        label: "Rex Milo Monitor",
        description:
          "Monitor the Milo OpenClaw container. Check status, view logs, restart if needed.",
        parameters: Type.Object({
          action: Type.Optional(
            Type.String({
              description: "Action: status (default), logs, restart",
            }),
          ),
          lines: Type.Optional(
            Type.Number({ description: "Number of log lines to fetch (default 50)" }),
          ),
        }),
        async execute(_toolCallId, params) {
          const action = typeof params.action === "string" ? params.action.trim() : "status";
          const lines = typeof params.lines === "number" ? Math.min(params.lines, 200) : 50;
          const containerName = "milo-openclaw";

          const text = (msg: string) => ({
            content: [{ type: "text" as const, text: msg }],
            details: {},
          });

          if (action === "logs") {
            const { stdout } = await new Promise<{ stdout: string }>((resolve) => {
              execFile(
                "docker",
                ["logs", "--tail", String(lines), containerName],
                { encoding: "utf-8", timeout: 10_000 },
                (_err, stdout) => resolve({ stdout: stdout?.trim() ?? "" }),
              );
            });

            return text(
              JSON.stringify({
                container: containerName,
                action: "logs",
                lines: stdout ? stdout.split("\n").length : 0,
                content: stdout.slice(0, 3000),
              }),
            );
          }

          if (action === "restart") {
            const { exitCode, stderr } = await new Promise<{
              exitCode: number;
              stderr: string;
            }>((resolve) => {
              execFile(
                "docker",
                ["restart", containerName],
                { encoding: "utf-8", timeout: 30_000 },
                (err, _stdout, stderr) =>
                  resolve({ exitCode: err ? 1 : 0, stderr: stderr?.trim() ?? "" }),
              );
            });

            return text(
              JSON.stringify({
                container: containerName,
                action: "restart",
                success: exitCode === 0,
                error: exitCode !== 0 ? stderr : undefined,
              }),
            );
          }

          // Default: status
          const { stdout, exitCode } = await new Promise<{
            stdout: string;
            exitCode: number;
          }>((resolve) => {
            execFile(
              "docker",
              [
                "inspect",
                "--format",
                "{{.State.Status}} | Started: {{.State.StartedAt}} | Restarts: {{.RestartCount}}",
                containerName,
              ],
              { encoding: "utf-8", timeout: 10_000 },
              (err, stdout) => resolve({ stdout: stdout?.trim() ?? "", exitCode: err ? 1 : 0 }),
            );
          });

          const miloLogs = getRecentLogs(20).filter((l) => l.source === "milo");

          return text(
            JSON.stringify({
              container: containerName,
              action: "status",
              status: exitCode === 0 ? stdout : "container not found",
              recentEvents: miloLogs.slice(-5),
            }),
          );
        },
      }),
      { name: "rex_milo_monitor" },
    );
  },
});
